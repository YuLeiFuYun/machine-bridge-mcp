import assert from "node:assert/strict";
import {
  MCP_HEADER_MISMATCH,
  MCP_PROTOCOL_VERSION,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  McpProtocolError,
  cacheableResult,
  completeResult,
  discoverResult,
  requestProtocolVersion,
  serverImplementation,
  validateRequestMetadata,
} from "../src/shared/mcp-protocol.mjs";
import {
  MCP_DISCOVERY_TTL_MS, MCP_INSTRUCTIONS, MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_CAPABILITIES, MCP_TOOL_LIST_TTL_MS, SERVER_NAME, mcpServerInfo,
} from "../src/worker/worker-mcp-config.ts";
import {
  McpHttpContractError,
  decodeMcpHeaderValue,
  toolParameterHeaderNames,
  validateHttpRequest,
  validateOptionalCompatibilityMirrors,
  validateToolHeaderSchemas,
} from "../src/worker/mcp-http-contract.ts";

const serverInfo = serverImplementation({ name: "machine-bridge-mcp", version: "test", title: "Machine Bridge MCP" });
const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1" },
};

const currentList = request("tools/list", { _meta: requestMeta });
assert.equal(requestProtocolVersion(currentList), MCP_PROTOCOL_VERSION);
assert.deepEqual(validateRequestMetadata(currentList).clientCapabilities, {});
assert.equal(validateRequestMetadata(request("tools/list", { _meta: {
  ...requestMeta,
  "io.modelcontextprotocol/clientInfo": {
    name: "", version: "", websiteUrl: "urn:example:client",
    icons: [{ src: "data:image/png;base64,AA==", theme: "dark" }],
  },
} })).clientInfo.name, "");
for (const clientCapabilities of [
  { experimental: { invalid: [] } },
  { sampling: { tools: "yes" } },
  { elicitation: { form: 1 } },
  { extensions: { "example.com/feature": [] } },
]) {
  assert.throws(
    () => validateRequestMetadata(request("tools/list", { _meta: { ...requestMeta, "io.modelcontextprotocol/clientCapabilities": clientCapabilities } })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
for (const clientInfo of [
  { name: "client", version: "1", websiteUrl: "/relative" },
  { name: "client", version: "1", icons: [{ src: "relative-icon.png", theme: "dark" }] },
  { name: "client", version: "1", icons: [{ src: "https://example.test/icon.png", theme: "contrast" }] },
]) {
  assert.throws(
    () => validateRequestMetadata(request("tools/list", { _meta: {
      ...requestMeta, "io.modelcontextprotocol/clientInfo": clientInfo,
    } })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
assert.equal(validateRequestMetadata(request("tools/list", { _meta: {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": { extensions: { "com.example/feature": {} } },
} })).clientInfo, null, "clientInfo should remain optional");
const oversizedMetadata = {
  ...requestMeta,
  "com.example/large": Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`k${index}`, index])),
};
assert.throws(
  () => validateRequestMetadata(request("tools/list", { _meta: oversizedMetadata })),
  (error) => error instanceof McpProtocolError && error.code === -32602 && !error.message.includes("k4095"),
);
let deeplyNestedMetadata = {};
for (let depth = 0; depth < 34; depth += 1) deeplyNestedMetadata = { child: deeplyNestedMetadata };
assert.throws(
  () => validateRequestMetadata(request("tools/list", { _meta: { ...requestMeta, "com.example/deep": deeplyNestedMetadata } })),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
for (const invalidMeta of [
  { ...requestMeta, "bad key": true },
  { ...requestMeta, progressToken: null },
  { ...requestMeta, "io.modelcontextprotocol/logLevel": "verbose" },
  { ...requestMeta, "io.modelcontextprotocol/clientCapabilities": { extensions: { unprefixed: {} } } },
  { ...requestMeta, "io.modelcontextprotocol/clientCapabilities": { roots: true } },
]) {
  assert.throws(
    () => validateRequestMetadata(request("tools/list", { _meta: invalidMeta })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
assert.throws(
  () => validateRequestMetadata(request("tools/list", { _meta: {} })),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
assert.throws(
  () => validateRequestMetadata(request("tools/list", { _meta: { ...requestMeta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } })),
  (error) => error instanceof McpProtocolError
    && error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION
    && error.data.supported[0] === MCP_PROTOCOL_VERSION,
);
assert.throws(
  () => validateRequestMetadata(request("tools/list", { _meta: {
    ...requestMeta, "io.modelcontextprotocol/protocolVersion": "v".repeat(4096),
  } })),
  (error) => error instanceof McpProtocolError
    && error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION
    && error.data.requested === "<invalid-length>"
    && error.message.length < 128,
);
for (const invalidMeta of [
  { ...requestMeta, ["private-" + "x".repeat(4096) + " key"]: true },
  { ...requestMeta, "io.modelcontextprotocol/clientCapabilities": {
    extensions: { ["private-" + "x".repeat(4096)]: {} },
  } },
]) {
  assert.throws(
    () => validateRequestMetadata(request("tools/list", { _meta: invalidMeta })),
    (error) => error instanceof McpProtocolError
      && error.code === -32602 && error.message.length < 128 && !error.message.includes("private-"),
  );
}

const complete = completeResult({ value: 1 }, serverInfo);
assert.equal(complete.resultType, "complete");
assert.deepEqual(complete._meta["io.modelcontextprotocol/serverInfo"], serverInfo);
const cacheable = cacheableResult({ tools: [] }, { ttlMs: 0, cacheScope: "private", serverInfo });
assert.equal(cacheable.resultType, "complete");
assert.equal(cacheable.ttlMs, 0);
assert.equal(cacheable.cacheScope, "private");
const discovery = discoverResult({
  supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, instructions: "Use tools.", serverInfo,
});
assert.deepEqual(discovery.supportedVersions, [MCP_PROTOCOL_VERSION]);
assert.equal(discovery.cacheScope, "public");
assert.equal(SERVER_NAME, "machine-bridge-mcp");
assert.deepEqual(MCP_PROTOCOL_VERSIONS, [MCP_PROTOCOL_VERSION]);
assert(MCP_INSTRUCTIONS.length > 0 && MCP_SERVER_CAPABILITIES.tools.listChanged === false);
assert(MCP_DISCOVERY_TTL_MS > 0 && MCP_TOOL_LIST_TTL_MS > 0);
assert.equal(mcpServerInfo("test").version, "test");

const unknownVersionHeaders = new Headers({
  "MCP-Protocol-Version": "1900-01-01",
  "Mcp-Method": "tools/list",
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
});
assert.throws(
  () => validateHttpRequest({ request: { headers: unknownVersionHeaders }, body: request("tools/list", {}) }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  "request headers without matching body metadata did not fail with HeaderMismatch",
);

const tool = {
  name: "echo_header",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      nested: { type: "object", properties: { enabled: { type: "boolean", "x-mcp-header": "Enabled" } } },
      count: { type: "integer", "x-mcp-header": "Count" },
    },
  },
};
validateToolHeaderSchemas([tool]);
assert.deepEqual([...toolParameterHeaderNames([tool])].sort(), [
  "mcp-param-count", "mcp-param-enabled", "mcp-param-region",
]);
const call = request("tools/call", {
  _meta: requestMeta,
  name: tool.name,
  arguments: { region: "世界", nested: { enabled: true }, count: 42 },
});
const headers = currentHeaders("tools/call", tool.name);
headers.set("Mcp-Param-Region", encodeHeader("世界"));
headers.set("Mcp-Param-Enabled", "true");
headers.set("Mcp-Param-Count", "42.0");
const context = validateHttpRequest({ request: { headers }, body: call, tools: [tool] });
assert.equal(context.version, MCP_PROTOCOL_VERSION);
const missingCurrentName = request("tools/call", { _meta: requestMeta, arguments: {} });
assert.throws(
  () => validateHttpRequest({
    request: { headers: currentHeaders("tools/call") },
    body: missingCurrentName,
    tools: [tool],
  }),
  (error) => error instanceof McpHttpContractError && error.code === -32602 && error.message === "name must be a string",
  "current tools/call body validation did not precede its missing mirrored-name header error",
);
const compatibilityHeaders = new Headers();
assert.doesNotThrow(() => validateOptionalCompatibilityMirrors({ headers: compatibilityHeaders, body: call, tools: [tool] }),
  "stateless compatibility unexpectedly required current mirrored headers");
compatibilityHeaders.set("Mcp-Method", "tools/call");
compatibilityHeaders.set("Mcp-Name", tool.name);
compatibilityHeaders.set("Mcp-Param-Region", encodeHeader("世界"));
assert.doesNotThrow(() => validateOptionalCompatibilityMirrors({ headers: compatibilityHeaders, body: call, tools: [tool] }),
  "matching optional compatibility mirrors were rejected");
for (const mutate of [
  (value) => value.set("Mcp-Method", "tools/list"),
  (value) => value.set("Mcp-Name", "other"),
  (value) => value.set("Mcp-Param-Region", "other"),
  (value) => value.set("Mcp-Param-Enabled", "false"),
  (value) => value.set("Mcp-Param-Undeclared", "other"),
]) {
  const changed = new Headers(compatibilityHeaders);
  mutate(changed);
  assert.throws(
    () => validateOptionalCompatibilityMirrors({ headers: changed, body: call, tools: [tool] }),
    (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  );
}
for (const unexpectedHeaders of [
  new Headers({ "Mcp-Name": tool.name }),
  new Headers({ "Mcp-Param-Region": "us" }),
]) {
  assert.throws(
    () => validateOptionalCompatibilityMirrors({
      headers: unexpectedHeaders,
      body: request("tools/list", { _meta: requestMeta }),
      tools: [tool],
    }),
    (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  );
}
const unknownBodyVersion = request("server/discover", { _meta: {
  ...requestMeta,
  "io.modelcontextprotocol/protocolVersion": "1900-01-01",
} });
const missingBodyVersion = request("server/discover", { _meta: {
  "io.modelcontextprotocol/clientCapabilities": {},
} });
assert.throws(
  () => validateHttpRequest({ request: { headers: currentHeaders("server/discover") }, body: missingBodyVersion }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  "missing body protocol version did not preserve HTTP header/body mismatch precedence",
);
assert.throws(
  () => validateHttpRequest({ request: { headers: currentHeaders("server/discover") }, body: unknownBodyVersion }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  "header/body version mismatch must take precedence over unsupported-version handling",
);
const unknownMatchingHeaders = currentHeaders("server/discover");
unknownMatchingHeaders.set("MCP-Protocol-Version", "1900-01-01");
assert.throws(
  () => validateHttpRequest({ request: { headers: unknownMatchingHeaders }, body: unknownBodyVersion }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION,
);
for (const accept of [
  "", "application/json", "text/event-stream", "application/json, text/event-stream;q=0",
  "application/json, text/event-stream;q=1.1", "application/json, text/event-stream;q=-1",
  "application/json, text/event-stream;q=0.1234", "application/json, text/event-stream;q=.5",
  "application/json, text/event-stream;q=1;q=0.5",
]) {
  const missingAccept = new Headers(headers);
  if (accept) missingAccept.set("Accept", accept); else missingAccept.delete("Accept");
  assert.throws(
    () => validateHttpRequest({ request: { headers: missingAccept }, body: call, tools: [tool] }),
    (error) => error instanceof McpHttpContractError && error.code === -32600,
  );
}
for (const accept of [
  "application/json;q=1, text/event-stream;q=0.001",
  "application/json;q=1.000, text/event-stream;q=0.5",
]) {
  const acceptedHeaders = new Headers(headers);
  acceptedHeaders.set("Accept", accept);
  assert.equal(validateHttpRequest({ request: { headers: acceptedHeaders }, body: call, tools: [tool] }).version,
    MCP_PROTOCOL_VERSION);
}
for (const contentType of ["", "text/plain", "application/jsonx", "text/plain; a=application/json"]) {
  const invalidContentType = new Headers(headers);
  if (contentType) invalidContentType.set("Content-Type", contentType); else invalidContentType.delete("Content-Type");
  assert.throws(
    () => validateHttpRequest({ request: { headers: invalidContentType }, body: call, tools: [tool] }),
    (error) => error instanceof McpHttpContractError && error.status === 415 && error.code === -32600,
    `current request accepted invalid Content-Type: ${contentType || "<missing>"}`,
  );
}
for (const contentType of ["application/json", "Application/JSON", "application/json; charset=utf-8"]) {
  const validContentType = new Headers(headers);
  validContentType.set("Content-Type", contentType);
  assert.equal(validateHttpRequest({ request: { headers: validContentType }, body: call, tools: [tool] }).version,
    MCP_PROTOCOL_VERSION);
}
assert.equal(decodeMcpHeaderValue(encodeHeader(" padded ")), " padded ");
const privateNameMismatch = new Headers(headers);
privateNameMismatch.set("Mcp-Name", encodeHeader("file:///private/user/path"));
assert.throws(
  () => validateHttpRequest({ request: { headers: privateNameMismatch }, body: call, tools: [tool] }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH
    && error.data === undefined && !error.message.includes("file:///private/user/path"),
  "header mismatch reflected private header/body values",
);

for (const mutate of [
  (value) => value.delete("Mcp-Method"),
  (value) => value.set("Mcp-Method", "tools/list"),
  (value) => value.set("MCP-Protocol-Version", "1900-01-01"),
  (value) => value.set("Mcp-Name", "other"),
  (value) => value.delete("Mcp-Param-Region"),
  (value) => value.set("Mcp-Param-Enabled", "false"),
]) {
  const changed = new Headers(headers);
  mutate(changed);
  assert.throws(
    () => validateHttpRequest({ request: { headers: changed }, body: call, tools: [tool] }),
    (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH && error.status === 400,
  );
}

assert.throws(
  () => validateToolHeaderSchemas([{
    name: "invalid",
    inputSchema: { type: "object", properties: { values: { type: "array", items: { type: "string", "x-mcp-header": "Value" } } } },
  }]),
  /outside a properties-only path/,
);
assert.throws(
  () => validateToolHeaderSchemas([{
    name: "duplicate",
    inputSchema: { type: "object", properties: {
      one: { type: "string", "x-mcp-header": "Region" },
      two: { type: "string", "x-mcp-header": "region" },
    } },
  }]),
  /duplicate/,
);

console.log("MCP 2026-07-28 protocol contract test ok");

function request(method, params) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

function currentHeaders(method, name = "") {
  const headers = new Headers({
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (name) headers.set("Mcp-Name", encodeHeader(name));
  return headers;
}

function encodeHeader(value) {
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
