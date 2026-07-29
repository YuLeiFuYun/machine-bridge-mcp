import assert from "node:assert/strict";
import {
  MCP_HEADER_MISMATCH,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  McpProtocolError,
  modernCacheableResult,
  modernCompleteResult,
  modernDiscoverResult,
  requestProtocolVersion,
  serverImplementation,
  validateModernRequestMetadata,
} from "../src/shared/mcp-protocol.mjs";
import {
  acceptedSubscriptionFilter, subscriptionAcknowledgedNotification, subscriptionCompleteResult, validateSubscriptionFilter,
} from "../src/shared/mcp-subscriptions.mjs";
import {
  MCP_DISCOVERY_TTL_MS, MCP_INSTRUCTIONS, MCP_LEGACY_PROTOCOL_VERSIONS, MCP_MODERN_PROTOCOL_VERSIONS,
  MCP_SERVER_CAPABILITIES, MCP_TOOL_LIST_TTL_MS, SERVER_NAME, mcpServerInfo,
} from "../src/worker/worker-mcp-config.ts";
import {
  McpHttpContractError,
  decodeMcpHeaderValue,
  detectHttpMcpEra,
  toolParameterHeaderNames,
  validateModernHttpRequest,
  validateToolHeaderSchemas,
} from "../src/worker/mcp-http-contract.ts";

const serverInfo = serverImplementation({ name: "machine-bridge-mcp", version: "test", title: "Machine Bridge MCP" });
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1" },
};

const modernList = request("tools/list", { _meta: modernMeta });
assert.equal(requestProtocolVersion(modernList), MCP_MODERN_PROTOCOL_VERSION);
assert.deepEqual(validateModernRequestMetadata(modernList).clientCapabilities, {});
assert.equal(validateModernRequestMetadata(request("tools/list", { _meta: {
  ...modernMeta,
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
    () => validateModernRequestMetadata(request("tools/list", { _meta: { ...modernMeta, "io.modelcontextprotocol/clientCapabilities": clientCapabilities } })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
for (const clientInfo of [
  { name: "client", version: "1", websiteUrl: "/relative" },
  { name: "client", version: "1", icons: [{ src: "relative-icon.png", theme: "dark" }] },
  { name: "client", version: "1", icons: [{ src: "https://example.test/icon.png", theme: "contrast" }] },
]) {
  assert.throws(
    () => validateModernRequestMetadata(request("tools/list", { _meta: {
      ...modernMeta, "io.modelcontextprotocol/clientInfo": clientInfo,
    } })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
assert.equal(validateModernRequestMetadata(request("tools/list", { _meta: {
  "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": { extensions: { "com.example/feature": {} } },
} })).clientInfo, null, "clientInfo should remain optional");
const oversizedMetadata = {
  ...modernMeta,
  "com.example/large": Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`k${index}`, index])),
};
assert.throws(
  () => validateModernRequestMetadata(request("tools/list", { _meta: oversizedMetadata })),
  (error) => error instanceof McpProtocolError && error.code === -32602 && !error.message.includes("k4095"),
);
let deeplyNestedMetadata = {};
for (let depth = 0; depth < 34; depth += 1) deeplyNestedMetadata = { child: deeplyNestedMetadata };
assert.throws(
  () => validateModernRequestMetadata(request("tools/list", { _meta: { ...modernMeta, "com.example/deep": deeplyNestedMetadata } })),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
for (const invalidMeta of [
  { ...modernMeta, "bad key": true },
  { ...modernMeta, progressToken: null },
  { ...modernMeta, "io.modelcontextprotocol/logLevel": "verbose" },
  { ...modernMeta, "io.modelcontextprotocol/clientCapabilities": { extensions: { unprefixed: {} } } },
  { ...modernMeta, "io.modelcontextprotocol/clientCapabilities": { roots: true } },
]) {
  assert.throws(
    () => validateModernRequestMetadata(request("tools/list", { _meta: invalidMeta })),
    (error) => error instanceof McpProtocolError && error.code === -32602,
  );
}
assert.throws(
  () => validateModernRequestMetadata(request("tools/list", { _meta: {} })),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
assert.throws(
  () => validateModernRequestMetadata(request("tools/list", { _meta: { ...modernMeta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } })),
  (error) => error instanceof McpProtocolError
    && error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION
    && error.data.supported[0] === MCP_MODERN_PROTOCOL_VERSION,
);
assert.throws(
  () => validateModernRequestMetadata(request("tools/list", { _meta: {
    ...modernMeta, "io.modelcontextprotocol/protocolVersion": "v".repeat(4096),
  } })),
  (error) => error instanceof McpProtocolError
    && error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION
    && error.data.requested === "<invalid-length>"
    && error.message.length < 128,
);
for (const invalidMeta of [
  { ...modernMeta, ["private-" + "x".repeat(4096) + " key"]: true },
  { ...modernMeta, "io.modelcontextprotocol/clientCapabilities": {
    extensions: { ["private-" + "x".repeat(4096)]: {} },
  } },
]) {
  assert.throws(
    () => validateModernRequestMetadata(request("tools/list", { _meta: invalidMeta })),
    (error) => error instanceof McpProtocolError
      && error.code === -32602 && error.message.length < 128 && !error.message.includes("private-"),
  );
}

const complete = modernCompleteResult({ value: 1 }, serverInfo);
assert.equal(complete.resultType, "complete");
assert.deepEqual(complete._meta["io.modelcontextprotocol/serverInfo"], serverInfo);
const cacheable = modernCacheableResult({ tools: [] }, { ttlMs: 0, cacheScope: "private", serverInfo });
assert.equal(cacheable.resultType, "complete");
assert.equal(cacheable.ttlMs, 0);
assert.equal(cacheable.cacheScope, "private");
const discovery = modernDiscoverResult({
  supportedVersions: [MCP_MODERN_PROTOCOL_VERSION], capabilities: { tools: {} }, instructions: "Use tools.", serverInfo,
});
assert.deepEqual(discovery.supportedVersions, [MCP_MODERN_PROTOCOL_VERSION]);
assert.equal(discovery.cacheScope, "public");
assert.equal(SERVER_NAME, "machine-bridge-mcp");
assert.deepEqual(MCP_MODERN_PROTOCOL_VERSIONS, [MCP_MODERN_PROTOCOL_VERSION]);
assert.deepEqual(MCP_LEGACY_PROTOCOL_VERSIONS, ["2025-11-25"]);
assert(MCP_INSTRUCTIONS.length > 0 && MCP_SERVER_CAPABILITIES.tools.listChanged === false);
assert(MCP_DISCOVERY_TTL_MS > 0 && MCP_TOOL_LIST_TTL_MS > 0);
assert.equal(mcpServerInfo("test").version, "test");

const requestedSubscriptions = validateSubscriptionFilter({
  toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ["a", "a", "b"], extensionField: { ok: true },
});
const acceptedSubscriptions = acceptedSubscriptionFilter(requestedSubscriptions, {
  tools: { listChanged: true }, resources: { listChanged: false, subscribe: true },
});
assert.deepEqual(acceptedSubscriptions, { toolsListChanged: true, resourceSubscriptions: ["a", "b"] });
assert.throws(() => validateSubscriptionFilter(null), (error) => error instanceof McpProtocolError && error.code === -32602);
assert.throws(() => validateSubscriptionFilter({ resourceSubscriptions: [1] }), (error) => error instanceof McpProtocolError && error.code === -32602);
assert.throws(
  () => validateSubscriptionFilter({ resourceSubscriptions: Array.from({ length: 257 }, (_, index) => `file:///r/${index}`) }),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
assert.throws(
  () => validateSubscriptionFilter({ extension: Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`k${index}`, index])) }),
  (error) => error instanceof McpProtocolError && error.code === -32602,
);
assert.throws(() => validateSubscriptionFilter({ promptsListChanged: 1 }), (error) => error instanceof McpProtocolError && error.code === -32602);
assert.deepEqual(acceptedSubscriptionFilter({
  toolsListChanged: false, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ["", "r"],
}, { prompts: { listChanged: true }, resources: { listChanged: true, subscribe: false } }), {
  promptsListChanged: true, resourcesListChanged: true,
});
const acknowledged = subscriptionAcknowledgedNotification(7, acceptedSubscriptions);
assert.equal(acknowledged.params._meta["io.modelcontextprotocol/subscriptionId"], 7);
assert.equal(subscriptionCompleteResult(7, serverInfo).resultType, "complete");

assert.equal(detectHttpMcpEra({ headers: new Headers() }, request("initialize", {})), "legacy");
assert.equal(detectHttpMcpEra({ headers: modernHeaders("server/discover") }, request("server/discover", { _meta: modernMeta })), "modern");
assert.equal(detectHttpMcpEra({ headers: new Headers({ "MCP-Protocol-Version": "2025-11-25" }) }, request("tools/list", {})), "legacy");

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
  _meta: modernMeta,
  name: tool.name,
  arguments: { region: "世界", nested: { enabled: true }, count: 42 },
});
const headers = modernHeaders("tools/call", tool.name);
headers.set("Mcp-Param-Region", encodeHeader("世界"));
headers.set("Mcp-Param-Enabled", "true");
headers.set("Mcp-Param-Count", "42.0");
const context = validateModernHttpRequest({ request: { headers }, body: call, tools: [tool] });
assert.equal(context.version, MCP_MODERN_PROTOCOL_VERSION);
const unknownBodyVersion = request("server/discover", { _meta: {
  ...modernMeta,
  "io.modelcontextprotocol/protocolVersion": "1900-01-01",
} });
assert.throws(
  () => validateModernHttpRequest({ request: { headers: modernHeaders("server/discover") }, body: unknownBodyVersion }),
  (error) => error instanceof McpHttpContractError && error.code === MCP_HEADER_MISMATCH,
  "header/body version mismatch must take precedence over unsupported-version handling",
);
const unknownMatchingHeaders = modernHeaders("server/discover");
unknownMatchingHeaders.set("MCP-Protocol-Version", "1900-01-01");
assert.throws(
  () => validateModernHttpRequest({ request: { headers: unknownMatchingHeaders }, body: unknownBodyVersion }),
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
    () => validateModernHttpRequest({ request: { headers: missingAccept }, body: call, tools: [tool] }),
    (error) => error instanceof McpHttpContractError && error.code === -32600,
  );
}
for (const accept of [
  "application/json;q=1, text/event-stream;q=0.001",
  "application/json;q=1.000, text/event-stream;q=0.5",
]) {
  const acceptedHeaders = new Headers(headers);
  acceptedHeaders.set("Accept", accept);
  assert.equal(validateModernHttpRequest({ request: { headers: acceptedHeaders }, body: call, tools: [tool] }).version,
    MCP_MODERN_PROTOCOL_VERSION);
}
assert.equal(decodeMcpHeaderValue(encodeHeader(" padded ")), " padded ");
const privateNameMismatch = new Headers(headers);
privateNameMismatch.set("Mcp-Name", encodeHeader("file:///private/user/path"));
assert.throws(
  () => validateModernHttpRequest({ request: { headers: privateNameMismatch }, body: call, tools: [tool] }),
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
    () => validateModernHttpRequest({ request: { headers: changed }, body: call, tools: [tool] }),
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

function modernHeaders(method, name = "") {
  const headers = new Headers({
    "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
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
