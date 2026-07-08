/**
 * MCP client transport factory.
 *
 * This module turns normalized MCP server config into stdio, SSE, or
 * streamable-HTTP SDK transports with OpenClaw auth, redirect, and logging rules.
 */
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";
import { logDebug, logWarn } from "../logger.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";
import { createMcpOAuthClientProvider } from "./mcp-oauth.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  detachStderr?: () => void;
};

type McpTransportSessionContext = {
  agentSessionId?: string;
  agentSessionKey?: string;
  sandboxSessionKey?: string;
};

const GNAME_MCP_SERVER_NAME = "gname";
const GNAME_DYNAMIC_HEADER_NAME = "x-gn-skw";
const GNAME_DYNAMIC_HEADER_ENDPOINT = "http://127.0.0.1:8095";
const GNAME_DYNAMIC_HEADER_TIMEOUT_MS = 5_000;
const GNAME_DYNAMIC_HEADER_DENYLIST = new Set([
  "connection",
  "content-length",
  "host",
  "mcp-session-id",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function attachStderrLogging(serverName: string, transport: OpenClawStdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message =
      normalizeOptionalString(typeof chunk === "string" ? chunk : String(chunk)) ?? "";
    if (!message) {
      return;
    }
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  stderr.on("data", onData);
  return () => {
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
    }
  };
}

type SseEventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;

function buildSseEventSourceFetch(
  headers: Record<string, string>,
  baseFetch: FetchLike,
): SseEventSourceFetch {
  return (url: string | URL, init?: RequestInit) => {
    // Header names are case-insensitive, but object spreads preserve case
    // variants and can duplicate Authorization on the wire. Normalize before
    // merging so operator headers override SDK headers as a single entry.
    const mergedHeaders: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders[key.toLowerCase()] = value;
    }
    return baseFetch(url, {
      ...(init as RequestInit),
      headers: mergedHeaders,
    }) as ReturnType<SseEventSourceFetch>;
  };
}

function readRequestMethod(init?: RequestInit): string {
  const method = normalizeOptionalString(init?.method);
  return method ? method.toUpperCase() : "GET";
}

function readRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [key, value] of new Headers(init?.headers)) {
    headers.set(key, value);
  }
  return headers;
}

function readRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.toString() : input;
}

function normalizeDynamicHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeOptionalString(String(value));
  }
  return undefined;
}

function isSafeDynamicHeader(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase();
  if (GNAME_DYNAMIC_HEADER_DENYLIST.has(normalizedName)) {
    logWarn(`bundle-mcp: ignored forbidden gname dynamic header ${normalizedName}.`);
    return false;
  }
  try {
    new Headers([[name, value]]);
    return true;
  } catch {
    logWarn(`bundle-mcp: ignored invalid gname dynamic header ${normalizedName}.`);
    return false;
  }
}

function readDynamicGnameHeaders(body: unknown): Record<string, string> {
  if (typeof body === "string") {
    const value = normalizeOptionalString(body);
    return value ? { [GNAME_DYNAMIC_HEADER_NAME]: value } : {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const record = body as Record<string, unknown>;
  const dynamicHeaders: Record<string, string> = {};
  if (record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)) {
    for (const [name, rawValue] of Object.entries(record.headers as Record<string, unknown>)) {
      const value = normalizeDynamicHeaderValue(rawValue);
      if (value && isSafeDynamicHeader(name, value)) {
        dynamicHeaders[name] = value;
      }
    }
  }
  for (const key of [GNAME_DYNAMIC_HEADER_NAME, "skw", "value"]) {
    const value = normalizeDynamicHeaderValue(record[key]);
    if (value && isSafeDynamicHeader(GNAME_DYNAMIC_HEADER_NAME, value)) {
      dynamicHeaders[GNAME_DYNAMIC_HEADER_NAME] = value;
      break;
    }
  }
  return dynamicHeaders;
}

async function fetchDynamicGnameHeader(params: {
  serverName: string;
  resourceUrl: string;
  requestUrl: string;
  method: string;
  mcpSessionId?: string;
  sessionContext?: McpTransportSessionContext;
}): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GNAME_DYNAMIC_HEADER_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await loadUndiciRuntimeDeps().fetch(GNAME_DYNAMIC_HEADER_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        serverName: params.serverName,
        resourceUrl: params.resourceUrl,
        requestUrl: params.requestUrl,
        method: params.method,
        ...(params.mcpSessionId ? { sessionId: params.mcpSessionId } : {}),
        ...(params.mcpSessionId ? { mcpSessionId: params.mcpSessionId } : {}),
        ...(params.sessionContext?.agentSessionId
          ? { agentSessionId: params.sessionContext.agentSessionId }
          : {}),
        ...(params.sessionContext?.agentSessionKey
          ? { agentSessionKey: params.sessionContext.agentSessionKey }
          : {}),
        ...(params.sessionContext?.sandboxSessionKey
          ? { sandboxSessionKey: params.sessionContext.sandboxSessionKey }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logWarn(
        `bundle-mcp: gname dynamic header endpoint returned HTTP ${response.status}; dynamic headers were not attached.`,
      );
      return {};
    }
    const contentType = response.headers.get("content-type") ?? "";
    const dynamicHeaders = readDynamicGnameHeaders(
      contentType.includes("application/json") ? await response.json() : await response.text(),
    );
    if (Object.keys(dynamicHeaders).length === 0) {
      logWarn("bundle-mcp: gname dynamic header endpoint returned no usable headers.");
    }
    return dynamicHeaders;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    logWarn(`bundle-mcp: failed to resolve gname dynamic headers for MCP request: ${errorName}`);
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function withGnameDynamicHeader(params: {
  serverName: string;
  resourceUrl: string;
  fetchFn: FetchLike;
  sessionContext?: McpTransportSessionContext;
}): FetchLike {
  if (params.serverName !== GNAME_MCP_SERVER_NAME) {
    return params.fetchFn;
  }
  const resourceOrigin = new URL(params.resourceUrl).origin;
  return async (url, init) => {
    const requestUrl = readRequestUrl(url);
    if (new URL(requestUrl).origin !== resourceOrigin) {
      return await params.fetchFn(url, init);
    }
    const headers = readRequestHeaders(url, init);
    const dynamicHeaders = await fetchDynamicGnameHeader({
      serverName: params.serverName,
      resourceUrl: params.resourceUrl,
      requestUrl,
      method: readRequestMethod(init),
      mcpSessionId: headers.get("mcp-session-id") ?? undefined,
      sessionContext: params.sessionContext,
    });
    for (const [name, value] of Object.entries(dynamicHeaders)) {
      headers.set(name, value);
    }
    return await params.fetchFn(url, { ...(init as RequestInit), headers });
  };
}

/** Resolves a configured MCP server into a live SDK transport instance. */
export function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
  sessionContext?: McpTransportSessionContext,
): ResolvedMcpTransport | null {
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      stderr: "pipe",
    });
    return {
      transport,
      description: resolved.description,
      transportType: "stdio",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }
  const authProvider =
    resolved.auth === "oauth"
      ? createMcpOAuthClientProvider({
          serverName,
          serverUrl: resolved.url,
          config: resolved.oauth,
        })
      : undefined;
  const baseFetch = buildMcpHttpFetch({
    sslVerify: resolved.sslVerify,
    clientCert: resolved.clientCert,
    clientKey: resolved.clientKey,
    resourceUrl: resolved.url,
  });
  const headers =
    resolved.auth === "oauth" ? withoutMcpAuthorizationHeader(resolved.headers) : resolved.headers;
  const httpFetch =
    resolved.auth === "oauth"
      ? withSameOriginMcpHttpHeaders({
          fetchFn: baseFetch,
          headers,
          resourceUrl: resolved.url,
        })
      : baseFetch;
  const streamableHttpFetch = withGnameDynamicHeader({
    serverName,
    resourceUrl: resolved.url,
    fetchFn: httpFetch,
    sessionContext,
  });
  if (resolved.transportType === "streamable-http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: resolved.auth === "oauth" || !headers ? undefined : { headers },
        fetch: streamableHttpFetch,
        authProvider,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      supportsParallelToolCalls: resolved.supportsParallelToolCalls,
    };
  }
  const sseHeaders: Record<string, string> = { ...headers };
  const hasHeaders = Object.keys(sseHeaders).length > 0;
  return {
    transport: new SSEClientTransport(new URL(resolved.url), {
      requestInit: resolved.auth === "oauth" || !hasHeaders ? undefined : { headers: sseHeaders },
      fetch: httpFetch,
      eventSourceInit: {
        fetch: buildSseEventSourceFetch(resolved.auth === "oauth" ? {} : sseHeaders, httpFetch),
      },
      authProvider,
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
  };
}
