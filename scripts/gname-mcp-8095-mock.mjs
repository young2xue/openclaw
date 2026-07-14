#!/usr/bin/env node
import http from "node:http";

const HOST = process.env.GNAME_MCP_MOCK_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.GNAME_MCP_MOCK_PORT ?? "8095", 10);
const STATIC_SKW = process.env.GNAME_MCP_MOCK_SKW ?? "mock-x-gn-skw";
const STATIC_TOKEN = process.env.GNAME_MCP_MOCK_TOKEN ?? "mock-tenant-token";

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "method_not_allowed", expected: "POST" });
    return;
  }

  try {
    const rawBody = await readRequestBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const skw = `${STATIC_SKW}:${payload.serverName ?? "unknown"}:${payload.mcpSessionId ?? "no-mcp-session"}`;

    console.log("\n[gname-mcp-mock] received request");
    console.log(JSON.stringify(payload, null, 2));
    console.log("[gname-mcp-mock] returning headers: authorization, x-gn-skw");

    jsonResponse(res, 200, {
      headers: {
        Authorization: `Bearer ${STATIC_TOKEN}`,
        "x-gn-skw": skw,
      },
    });
  } catch (error) {
    console.error("[gname-mcp-mock] request failed:", error);
    jsonResponse(res, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[gname-mcp-mock] listening on http://${HOST}:${PORT}`);
  console.log("[gname-mcp-mock] override value with GNAME_MCP_MOCK_SKW=your-secret");
  console.log("[gname-mcp-mock] override token with GNAME_MCP_MOCK_TOKEN=tenant-token");
});

process.on("SIGINT", () => {
  server.close(() => {
    console.log("\n[gname-mcp-mock] stopped");
    process.exit(0);
  });
});
