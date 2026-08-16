import assert from "node:assert/strict";
import { McpController } from "../src/worker/mcp-controller.ts";
import { removedProtocolResponse } from "../src/worker/mcp-removed-protocol.ts";
import {
  initializationCompatibilityResponse, MCP_INITIALIZATION_COMPATIBILITY_VERSIONS,
} from "../src/worker/mcp-initialization-compat.ts";
import { MCP_PROTOCOL_VERSION, serverImplementation } from "../src/shared/mcp-protocol.mjs";
import { MCP_STREAM_PROXY_ID_HEADER, MCP_STREAM_PROXY_MODE_HEADER } from "../src/worker/mcp-stream-proxy-contract.ts";
import { serverInfoTool, workspaceTools } from "../src/worker/tool-catalog.ts";
import { WorkerToolError } from "../src/worker/errors.ts";

const STREAM_ID = `stream_${"A".repeat(43)}`;
const authorized = {
  tokenKey: "token-key",
  accountId: "account",
  accountVersion: 1,
  clientId: "client",
  familyId: "family",
  role: "owner",
};
const serverInfo = serverImplementation({ name: "machine-bridge-mcp", version: "test" });
const calls = [];
const cancellations = [];
const errors = [];
const controller = new McpController({
  capabilities: { tools: { listChanged: false } },
  serverInfo,
  instructions: "Use tools.",
  supportedVersions: [MCP_PROTOCOL_VERSION],
  discoveryTtlMs: 1000,
  toolListTtlMs: 2000,
  tools: () => [serverInfoTool, ...workspaceTools],
  recordError: (code) => errors.push(code),
  cancelClientRequest: async (key) => { cancellations.push(key); },
  callTool: async (input) => {
    calls.push(input);
    if (input.name === "read_file") throw new WorkerToolError("unavailable", "test unavailable", true);
    return { ok: true, name: input.name };
  },
});

assert.equal(removedProtocolResponse(new Request("https://example.test/mcp"), request("tools/list", {}), [MCP_PROTOCOL_VERSION]), null);
const removedInitialize = removedProtocolResponse(new Request("https://example.test/mcp"), request("initialize", {}), [MCP_PROTOCOL_VERSION]);
assert.equal(removedInitialize.status, 400);
assert.equal((await removedInitialize.json()).error.code, -32601);
const removedSession = removedProtocolResponse(new Request("https://example.test/mcp", {
  headers: { "Mcp-Session-Id": "obsolete" },
}), request("tools/list", {}), [MCP_PROTOCOL_VERSION]);
assert.equal(removedSession.status, 400);
assert.deepEqual((await removedSession.json()).error.data.supported, [MCP_PROTOCOL_VERSION]);
const futureSessionShape = removedProtocolResponse(new Request("https://example.test/mcp", {
  headers: { "Mcp-Session-Id": "future-shape" },
}), request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } }), [MCP_PROTOCOL_VERSION]);
assert.equal(futureSessionShape, null, "future protocol metadata was misclassified as a removed session protocol");

const legacyVersion = "2025-11-25";
assert.deepEqual([...MCP_INITIALIZATION_COMPATIBILITY_VERSIONS], ["2025-11-25", "2025-06-18"]);
for (const version of MCP_INITIALIZATION_COMPATIBILITY_VERSIONS) {
  const legacyInitialize = await initializationCompatibilityResponse(compatInput(
    legacyRequest("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "ChatGPT", version: "test" },
    }),
  ));
  assert.equal(legacyInitialize.status, 200);
  const legacyInitializeBody = await legacyInitialize.json();
  assert.equal(legacyInitializeBody.result.protocolVersion, version);
  assert.equal(legacyInitializeBody.result.serverInfo.name, "machine-bridge-mcp");
  assert.equal(legacyInitialize.headers.get("mcp-session-id"), null);
}

for (const version of [MCP_PROTOCOL_VERSION, "2024-11-05"]) {
  const notCompatibility = await initializationCompatibilityResponse(compatInput(
    legacyRequest("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "non-compat-client", version: "test" },
    }),
  ));
  assert.equal(notCompatibility, null, `initialization compatibility intercepted ${version}`);
}

const legacyInitialized = await initializationCompatibilityResponse(compatInput(
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { version: legacyVersion },
));
assert.equal(legacyInitialized.status, 202);
assert.equal(await legacyInitialized.text(), "");

const legacyPing = await initializationCompatibilityResponse(compatInput(
  legacyRequest("ping", {}), { version: legacyVersion },
));
assert.deepEqual((await legacyPing.json()).result, {});

const legacyTools = await initializationCompatibilityResponse(compatInput(
  legacyRequest("tools/list", {}), { version: legacyVersion },
));
assert.equal(legacyTools.status, 200);
assert((await legacyTools.json()).result.tools.some((tool) => tool.name === "list_dir"));

const legacySessionRejected = await initializationCompatibilityResponse(compatInput(
  legacyRequest("tools/list", {}), { version: legacyVersion, sessionId: "not-issued" },
)).catch((error) => error);
assert.equal(legacySessionRejected.code, -32600);

const legacyMismatch = await initializationCompatibilityResponse(compatInput(
  legacyRequest("initialize", {
    protocolVersion: legacyVersion,
    capabilities: {},
    clientInfo: { name: "ChatGPT", version: "test" },
  }), { version: "2025-06-18" },
)).catch((error) => error);
assert.equal(legacyMismatch.code, -32020);

const legacyMethodMismatch = await initializationCompatibilityResponse(compatInput(
  legacyRequest("tools/list", {}), { version: legacyVersion, method: "tools/call" },
)).catch((error) => error);
assert.equal(legacyMethodMismatch.code, -32020);

const legacyNameMismatch = await initializationCompatibilityResponse(compatInput(
  legacyRequest("tools/call", { name: "list_dir", arguments: { path: "." } }),
  { version: legacyVersion, method: "tools/call", name: "list_files" },
)).catch((error) => error);
assert.equal(legacyNameMismatch.code, -32020);

assert.equal(await controller.handleControl(new Request("https://example.test/mcp"), ""), null);
const invalidControl = await controller.handleControl(controlRequest("bad"), "cancel");
assert.equal(invalidControl.status, 400);
const validControl = await controller.handleControl(controlRequest(STREAM_ID), "cancel");
assert.equal(validControl.status, 202);
assert.equal(cancellations.length, 2);
assert.equal(cancellations[0], undefined);
assert.match(cancellations[1], /^stream:stream_/);

const notification = await handle({ jsonrpc: "2.0", method: "tools/list", params: {} });
assert.equal(notification.status, 404);
assert.equal((await notification.json()).error.code, -32601);
const nullId = await handle(request("tools/list", {}, null));
assert.equal(nullId.status, 400);
assert.equal((await nullId.json()).error.code, -32600);
const badStreamIdentity = await handle(request("tools/call", { name: "list_dir", arguments: { path: "." } }), {
  proxyMode: "direct",
});
assert.equal(badStreamIdentity.status, 400);

const discover = await jsonResult(await handle(request("server/discover", {})));
assert.equal(discover.result.resultType, "complete");
assert.deepEqual(discover.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
assert.equal(discover.result.cacheScope, "public");
const listed = await jsonResult(await handle(request("tools/list", {})));
assert.equal(listed.result.cacheScope, "private");
assert(listed.result.tools.some((tool) => tool.name === "list_dir"));
const removed = await handle(request("initialize", {}));
assert.equal(removed.status, 404);
assert.equal((await removed.json()).error.code, -32601);

const missingName = await jsonResult(await handle(request("tools/call", { arguments: {} }), { accept: "application/json" }));
assert.equal(missingName.error.code, -32602);
const unknown = await jsonResult(await handle(request("tools/call", { name: "not_a_tool", arguments: {} }), { accept: "application/json" }));
assert.equal(unknown.error.code, -32602);
const privateUnknownName = "private-" + "x".repeat(4096);
const boundedUnknown = await jsonResult(await handle(request("tools/call", {
  name: privateUnknownName, arguments: {},
}), { accept: "application/json" }));
assert.equal(boundedUnknown.error.code, -32602);
assert(!JSON.stringify(boundedUnknown).includes(privateUnknownName) && JSON.stringify(boundedUnknown).length < 1024);
const boundedMethod = await jsonResult(await handle(request("private-" + "x".repeat(4096), {})));
assert.equal(boundedMethod.error.code, -32601);
assert(JSON.stringify(boundedMethod).length < 1024);
const malformed = await jsonResult(await handle(request("tools/call", { name: "list_dir", arguments: { unexpected: true } }), { accept: "application/json" }));
assert.equal(malformed.error.code, -32602);
assert.equal(malformed.error.data.validation_issues[0].keyword, "additionalProperties");
const overDurableTimeoutSchema = await jsonResult(await handle(request("tools/call", {
  name: "run_process", arguments: { argv: ["must-not-run"], timeout_seconds: 601, idempotency_key: "over-durable-timeout" },
}), { accept: "application/json" }));
assert.equal(overDurableTimeoutSchema.result.isError, true);
assert.equal(overDurableTimeoutSchema.result.structuredContent.error.code, "invalid_request");
assert.equal(overDurableTimeoutSchema.result.structuredContent.error.details.side_effects_started, false);
assert.equal(overDurableTimeoutSchema.result.structuredContent.error.details.schema_refresh_recommended, true);
assert.equal(overDurableTimeoutSchema.result.structuredContent.error.details.validation_issues[0].keyword, "maximum");
const missingDurableRecoveryKey = await jsonResult(await handle(request("tools/call", {
  name: "run_process", arguments: { argv: ["must-not-run"], timeout_seconds: 10 },
}), { accept: "application/json" }));
assert.equal(missingDurableRecoveryKey.result.isError, true);
assert.equal(missingDurableRecoveryKey.result.structuredContent.error.code, "invalid_request");
assert.equal(missingDurableRecoveryKey.result.structuredContent.error.details.side_effects_started, false);
assert.equal(missingDurableRecoveryKey.result.structuredContent.error.details.schema_refresh_recommended, true);
assert.equal(missingDurableRecoveryKey.result.structuredContent.error.details.recovery_credential_required, "idempotency_key");
const staleReadPollSchema = await jsonResult(await handle(request("tools/call", {
  name: "read_process", arguments: { session_id: "proc_synthetic", wait_ms: 6000 },
}), { accept: "application/json" }));
assert.equal(staleReadPollSchema.result.isError, true);
assert.equal(staleReadPollSchema.result.structuredContent.error.code, "invalid_request");
assert.equal(staleReadPollSchema.result.structuredContent.error.details.side_effects_started, false);
assert.equal(staleReadPollSchema.result.structuredContent.error.details.schema_refresh_recommended, true);
assert.equal(staleReadPollSchema.result.structuredContent.error.details.validation_issues[0].instancePath, "/wait_ms");
const malformedReadPoll = await jsonResult(await handle(request("tools/call", {
  name: "read_process", arguments: { session_id: "proc_synthetic", wait_ms: "5000" },
}), { accept: "application/json" }));
assert.equal(malformedReadPoll.error.code, -32602);
assert.equal(malformedReadPoll.error.data.validation_issues[0].keyword, "type");
assert.equal(calls.length, 0);

const legacyMirrorsMatch = await initializationCompatibilityResponse(compatInput(
  legacyRequest("tools/call", { name: "list_dir", arguments: { path: "." } }),
  { version: legacyVersion, method: "tools/call", name: "list_dir" },
));
assert.equal(legacyMirrorsMatch.status, 200);

const succeeded = await jsonResult(await handle(request("tools/call", { name: "list_dir", arguments: { path: "." } }), { accept: "application/json" }));
assert.equal(succeeded.result.resultType, "complete");
assert.equal(succeeded.result.isError, false);
assert.equal(succeeded.result.structuredContent.ok, true);
const failed = await jsonResult(await handle(request("tools/call", { name: "read_file", arguments: { path: "x" } }), { accept: "application/json" }));
assert.equal(failed.result.resultType, "complete");
assert.equal(failed.result.isError, true);
assert.equal(failed.result.structuredContent.error.code, "unavailable");

const noSubscriptionStream = await handle(
  request("subscriptions/listen", { notifications: {} }), { accept: "application/json" },
);
assert.equal(noSubscriptionStream.status, 406);
assert.equal((await noSubscriptionStream.json()).error.code, -32602);
for (const params of [
  {},
  { notifications: null },
  { notifications: { toolsListChanged: "yes" } },
  { notifications: { resourceSubscriptions: Array(129).fill("file:///bounded") } },
  { notifications: { extension: deepSubscriptionFilter(40) } },
]) {
  const malformedSubscription = await handle(request("subscriptions/listen", params));
  assert.equal(malformedSubscription.status, 400);
  assert.equal((await malformedSubscription.json()).error.code, -32602);
}
const subscription = await handle(request("subscriptions/listen", {
  notifications: { toolsListChanged: true, unknownExtensionFilter: { enabled: true } },
}));
assert.equal(subscription.status, 200);
assert.match(subscription.headers.get("content-type") ?? "", /^text\/event-stream/);
const subscriptionMessages = sseJsonMessages(await subscription.text());
assert.equal(subscriptionMessages.length, 2);
assert.equal(subscriptionMessages[0].method, "notifications/subscriptions/acknowledged");
assert.deepEqual(subscriptionMessages[0].params.notifications, {});
assert.equal(subscriptionMessages[0].params._meta["io.modelcontextprotocol/subscriptionId"], 1);
assert.equal(subscriptionMessages[1].id, 1);
assert.equal(subscriptionMessages[1].result.resultType, "complete");
assert.equal(subscriptionMessages[1].result._meta["io.modelcontextprotocol/subscriptionId"], 1);
assert.equal(subscriptionMessages[1].result._meta["io.modelcontextprotocol/serverInfo"].name, "machine-bridge-mcp");

let resolveStream;
const streamController = new McpController({
  capabilities: { tools: {} }, serverInfo, instructions: "", supportedVersions: [MCP_PROTOCOL_VERSION],
  discoveryTtlMs: 0, toolListTtlMs: 0, tools: () => [serverInfoTool, ...workspaceTools],
  recordError: (code) => errors.push(code), cancelClientRequest: async () => {},
  callTool: ({ signal }) => new Promise((resolve) => {
    resolveStream = () => resolve({ cancelled: signal.aborted });
  }),
});
const streamed = await streamController.handleRequest(input(request("tools/call", {
  name: "list_dir", arguments: { path: "." },
}), { proxyMode: "direct", streamId: STREAM_ID }));
const streamReader = streamed.body.getReader();
assert.equal(new TextDecoder().decode((await streamReader.read()).value), ": connected\n\n");
await streamReader.cancel("client closed");
resolveStream();
await Promise.resolve();

const brokenController = new McpController({
  capabilities: { tools: {} }, serverInfo, instructions: "", supportedVersions: [MCP_PROTOCOL_VERSION],
  discoveryTtlMs: 0, toolListTtlMs: 0,
  tools: () => { throw new Error("private dispatcher failure"); },
  recordError: (code) => errors.push(code), cancelClientRequest: async () => {}, callTool: async () => ({}),
});
const broken = await brokenController.handleRequest(input(request("tools/call", {
  name: "list_dir", arguments: { path: "." },
}), { proxyMode: "direct", streamId: STREAM_ID }));
const brokenText = await broken.text();
assert(brokenText.includes('"code":-32603'));
assert(!brokenText.includes("private dispatcher failure"));
assert(errors.includes("mcp_stream_dispatch_failed"));

console.log("MCP controller test ok");

async function handle(body, options = {}) {
  return controller.handleRequest(input(body, options));
}

function input(body, options = {}) {
  const headers = new Headers({ accept: options.accept ?? "application/json, text/event-stream" });
  if (options.streamId) {
    headers.set(MCP_STREAM_PROXY_MODE_HEADER, "direct");
    headers.set(MCP_STREAM_PROXY_ID_HEADER, options.streamId);
  }
  return {
    request: new Request("https://example.test/mcp", { method: "POST", headers, body: "{}" }),
    body,
    base: "https://example.test",
    authorized,
    proxyMode: options.proxyMode ?? "",
  };
}

function request(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function legacyRequest(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function compatInput(body, options = {}) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (options.version) headers.set("MCP-Protocol-Version", options.version);
  if (options.sessionId) headers.set("Mcp-Session-Id", options.sessionId);
  if (options.method) headers.set("Mcp-Method", options.method);
  if (options.name) headers.set("Mcp-Name", options.name);
  return {
    request: new Request("https://example.test/mcp", { method: "POST", headers, body: "{}" }),
    body,
    base: "https://example.test",
    authorized,
    controller,
    capabilities: { tools: { listChanged: false } },
    serverInfo,
    instructions: "Use tools.",
    tools: [serverInfoTool, ...workspaceTools],
  };
}

function controlRequest(streamId) {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      [MCP_STREAM_PROXY_MODE_HEADER]: "cancel",
      [MCP_STREAM_PROXY_ID_HEADER]: streamId,
    },
  });
}

async function jsonResult(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

function sseJsonMessages(text) {
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

function deepSubscriptionFilter(depth) {
  let value = { enabled: true };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}
