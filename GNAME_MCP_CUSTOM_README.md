# gname MCP 动态请求头本地定制说明

这个 checkout 里包含一个面向本地使用的 OpenClaw 源码定制：当 OpenClaw 请求名为
`gname` 的远程 MCP 服务时，在真正发出 Streamable HTTP MCP 请求前，先调用本机服务
`127.0.0.1:8095` 获取动态请求头，然后把这些请求头合并到 MCP 请求里。

追加的请求头名称：

```http
x-gn-skw: <动态值>
Authorization: Bearer <客户自己的 MCP token>
```

本机辅助服务地址：

```text
POST http://127.0.0.1:8095
```

只有 MCP server 名称严格等于 `gname` 时才会启用这段逻辑；其他 MCP server 不受影响。

## 改动目标

目标是让 `gname` 这个 Streamable HTTP MCP 服务的每次同源请求都可以带上动态生成的
请求头。动态请求头由本机 `127.0.0.1:8095` 根据当前 MCP 会话、OpenClaw 智能体会话、
用户对话 session、以及沙盒 session 信息计算。

典型用途：

- 返回 `x-gn-skw`，给 `gname` 服务做动态签名或校验。
- 返回 `Authorization`，让不同客户共用一个 OpenClaw 进程时，按当前用户会话注入各自的
  MCP token。

当前实现是 fail-open：

- 8095 服务不可用时，不阻断 MCP 请求。
- 8095 返回非 2xx 时，不阻断 MCP 请求。
- 8095 返回空值或无法解析时，不阻断 MCP 请求。
- 上述情况只记录 warning，MCP 请求会继续发送，但不会带动态请求头。
- 日志只记录状态、header 名或错误类型，不记录 8095 返回的 header 值，避免 token 泄露。

## 修改过的文件

- `src/agents/mcp-transport.ts`
  - 增加只针对 `gname` 的 Streamable HTTP fetch wrapper。
  - 在同源 MCP 请求前调用 `http://127.0.0.1:8095`。
  - 从 8095 响应中读取动态请求头，并合并到 MCP 请求头。
  - 把 MCP session、agent session、sandbox session 信息放进 8095 请求体。
  - 拒绝 8095 覆盖 `mcp-session-id`、`content-length`、`host` 等协议/传输级 header。
  - warning 日志不打印 token 或动态 header 值。

- `src/agents/agent-bundle-mcp-runtime.ts`
  - 在创建 MCP transport 时，把当前 OpenClaw 会话上下文传下去。
  - 传递字段包括 `agentSessionId`、`agentSessionKey`、`sandboxSessionKey`。

- `src/agents/agent-bundle-mcp-types.ts`
  - 给 `SessionMcpRuntimeManager.getOrCreate(...)` 参数增加可选字段
    `sandboxSessionKey`。

- `src/agents/embedded-agent-runner/run/attempt.ts`
  - 把当前 run 已解析出的 `sandboxSessionKey` 传给 session MCP runtime。

- `src/agents/mcp-transport.test.ts`
  - 增加测试，确认 `gname` 请求会调用 8095 并追加 `x-gn-skw`。
  - 增加测试，确认 8095 返回的 `headers` 会合并到 MCP 请求。
  - 增加测试，确认 8095 不能替换当前 MCP 请求的 `mcp-session-id`。
  - 增加测试，确认非 `gname` 的 MCP server 不会调用 8095。
  - 测试覆盖 8095 请求体中的 MCP session、agent session、sandbox session 字段。

## 8095 请求体格式

OpenClaw 会向 `127.0.0.1:8095` 发送 JSON，形状如下：

```json
{
  "serverName": "gname",
  "resourceUrl": "https://mcp.example.com/mcp",
  "requestUrl": "https://mcp.example.com/mcp",
  "method": "POST",
  "sessionId": "mcp-session-id value",
  "mcpSessionId": "mcp-session-id value",
  "agentSessionId": "OpenClaw agent run/session id",
  "agentSessionKey": "OpenClaw conversation session key",
  "sandboxSessionKey": "OpenClaw sandbox/tool-policy session key"
}
```

字段说明：

- `serverName`
  - MCP server 配置名称。本定制只处理值为 `gname` 的 server。

- `resourceUrl`
  - MCP server 的配置 URL，也就是 OpenClaw 认为的 MCP 资源地址。

- `requestUrl`
  - 当前即将发出的 MCP HTTP 请求 URL。

- `method`
  - 当前 MCP HTTP 请求方法，例如 `GET`、`POST`、`DELETE`。

- `sessionId`
  - 为兼容最早本地版本保留。
  - 它表示 MCP 协议层的 session id，也就是 `mcp-session-id` 的值。
  - 建议新代码优先读 `mcpSessionId`，避免和 OpenClaw agent session 混淆。

- `mcpSessionId`
  - 明确命名的 MCP 协议层 session id。
  - 来源是 SDK 发出的 `mcp-session-id` 请求头。

- `agentSessionId`
  - OpenClaw 智能体本次对话/运行的 session id。
  - 来源是 `createSessionMcpRuntime({ sessionId })`。

- `agentSessionKey`
  - OpenClaw 用户对话路由 key。
  - 常见形态类似 `agent:main:...`。
  - 来源是 `createSessionMcpRuntime({ sessionKey })`。

- `sandboxSessionKey`
  - 沙盒和工具策略解析用的 session-like key。
  - 非沙盒模式下通常与 `agentSessionKey` 一致或接近。
  - 沙盒模式下可能不同，因此单独传给 8095。
  - 来源是 embedded run attempt 中解析出的 `sandboxSessionKey`。

## 8095 响应格式

推荐让 8095 返回 JSON，并把要注入 MCP 请求的 header 放在 `headers` 字段里：

```json
{
  "headers": {
    "x-gn-skw": "dynamic-secret",
    "Authorization": "Bearer customer-a-mcp-token"
  }
}
```

OpenClaw 会把 `headers` 里的可用字段合并进当前 MCP 请求头。header 名大小写不敏感，
如果和已有 header 重名，以 8095 返回值为准。但以下 header 不允许由 8095 覆盖：

- `mcp-session-id`
- `content-length`
- `host`
- `connection`
- `transfer-encoding`
- `te`
- `trailer`
- `upgrade`

原因是这些字段属于 MCP session 或 HTTP 传输层，允许动态服务覆盖会导致会话串租、
请求体长度错误或代理行为异常。

为了兼容最早的本地版本，也仍然支持直接返回纯文本：

```text
dynamic-secret
```

或者返回单字段 JSON：

```json
{ "x-gn-skw": "dynamic-secret" }
```

为了本地调试方便，也支持：

```json
{ "skw": "dynamic-secret" }
```

```json
{ "value": "dynamic-secret" }
```

这些兼容格式都会被转换成 MCP 请求头：

```http
x-gn-skw: dynamic-secret
```

生产环境如果要按客户注入 MCP token，建议使用 `headers.Authorization`：

```json
{
  "headers": {
    "Authorization": "Bearer customer-specific-token"
  }
}
```

注意：8095 服务可以打印收到的 session 参数用于排查，但不要打印返回的 token/header 值。
仓库里的 mock 脚本只打印返回的 header 名，不打印 `x-gn-skw` 的值。

## 本地模拟 8095 服务

仓库里新增了一个单文件 Node.js 模拟脚本：

```text
scripts/gname-mcp-8095-mock.mjs
```

启动方式：

```sh
node scripts/gname-mcp-8095-mock.mjs
```

默认监听：

```text
http://127.0.0.1:8095
```

脚本会打印收到的 JSON 参数，并返回：

```json
{
  "headers": {
    "x-gn-skw": "mock-x-gn-skw:gname:<mcpSessionId>"
  }
}
```

可以用环境变量改返回值前缀：

```sh
GNAME_MCP_MOCK_SKW=test-secret node scripts/gname-mcp-8095-mock.mjs
```

也可以改监听地址和端口：

```sh
GNAME_MCP_MOCK_HOST=0.0.0.0 GNAME_MCP_MOCK_PORT=8095 node scripts/gname-mcp-8095-mock.mjs
```

生产环境建议仍然只监听 `127.0.0.1`，避免把动态凭证服务暴露到外网。

## MCP session 的来源

MCP Streamable HTTP SDK 会管理协议层 session：

- server 在响应头里返回 `mcp-session-id`。
- SDK 保存这个值。
- SDK 后续 GET/POST/DELETE 请求都会通过 `_commonHeaders()` 带上
  `mcp-session-id`。

本地确认过的依赖源码：

- `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`

相关行为：

- `_commonHeaders()` 在 SDK 已有 session 时添加 `mcp-session-id`。
- `send()` 会从 POST 响应头读取并保存 `mcp-session-id`。
- `terminateSession()` 的 DELETE 请求也使用同一组 common headers。

## 调用链路

简化链路如下：

```text
embedded-agent-runner/run/attempt.ts
  -> getOrCreateSessionMcpRuntime({
       sessionId,
       sessionKey,
       sandboxSessionKey,
       ...
     })
  -> agent-bundle-mcp-runtime.ts
  -> resolveMcpTransport(serverName, rawServer, {
       agentSessionId,
       agentSessionKey,
       sandboxSessionKey
     })
  -> mcp-transport.ts
  -> withGnameDynamicHeader(...)
  -> POST http://127.0.0.1:8095
  -> merge dynamic headers into outgoing MCP request
```

## 验证命令

这次本地定制使用过的聚焦验证命令：

```sh
node scripts/run-vitest.mjs src/agents/mcp-transport.test.ts
git diff --check
```

当前聚焦测试结果：

```text
src/agents/mcp-transport.test.ts
14 tests passed
```

`autoreview` 也尝试运行过，但当前环境调用 OpenAI API 时被网络/区域 403 拦截，
所以没有完成自动审查。

## 后续维护提示

- 如果以后 `gname` 不再是固定 server 名称，需要优先改
  `src/agents/mcp-transport.ts` 里的 `GNAME_MCP_SERVER_NAME`。
- 如果 8095 地址变化，需要改 `GNAME_DYNAMIC_HEADER_ENDPOINT`。
- 如果 8095 返回 JSON 字段变化，需要改 `readDynamicGnameHeaders(...)`。
- 如果要允许或禁止更多动态 header，需要改 `GNAME_DYNAMIC_HEADER_DENYLIST`。
- 如果希望 8095 失败时阻断 MCP 请求，需要把当前 fail-open 行为改成抛错。
- 如果需要把这套逻辑做成通用配置项，建议不要继续硬编码 `gname`，而是新增正式的
  MCP server 配置字段和 schema；当前文件只是本地定制说明。
