import assert from "node:assert/strict";
import { ModernMcpController } from "../src/worker/mcp-modern-controller.ts";
import { MCP_MODERN_PROTOCOL_VERSION, serverImplementation } from "../src/shared/mcp-protocol.mjs";
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
const controller = new ModernMcpController({
  capabilities: { tools: { listChanged: false } },
  serverInfo,
  instructions: "Use tools.",
  supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
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

assert.equal(await controller.handleControl(new Request("https://example.test/mcp"), ""), null);
const invalidControl = await controller.handleControl(controlRequest("bad"), "modern-cancel");
assert.equal(invalidControl.status, 400);
const validControl = await controller.handleControl(controlRequest(STREAM_ID), "modern-cancel");
assert.equal(validControl.status, 202);
assert.equal(cancellations.length, 2);
assert.equal(cancellations[0], undefined);
assert.match(cancellations[1], /^modern:stream_/);

const notification = await handle({ jsonrpc: "2.0", method: "tools/list", params: {} });
assert.equal(notification.status, 404);
assert.equal((await notification.json()).error.code, -32601);
const nullId = await handle(request("tools/list", {}, null));
assert.equal(nullId.status, 400);
assert.equal((await nullId.json()).error.code, -32600);
const badStreamIdentity = await handle(request("tools/call", { name: "list_dir", arguments: { path: "." } }), {
  proxyMode: "modern-direct",
});
assert.equal(badStreamIdentity.status, 400);

const discover = await jsonResult(await handle(request("server/discover", {})));
assert.equal(discover.result.resultType, "complete");
assert.deepEqual(discover.result.supportedVersions, [MCP_MODERN_PROTOCOL_VERSION]);
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
assert.equal(calls.length, 0);

const succeeded = await jsonResult(await handle(request("tools/call", { name: "list_dir", arguments: { path: "." } }), { accept: "application/json" }));
assert.equal(succeeded.result.resultType, "complete");
assert.equal(succeeded.result.isError, false);
assert.equal(succeeded.result.structuredContent.ok, true);
const failed = await jsonResult(await handle(request("tools/call", { name: "read_file", arguments: { path: "x" } }), { accept: "application/json" }));
assert.equal(failed.result.resultType, "complete");
assert.equal(failed.result.isError, true);
assert.equal(failed.result.structuredContent.error.code, "unavailable");

const noEventStream = await handle(request("subscriptions/listen", { notifications: {} }), { accept: "application/json" });
assert.equal(noEventStream.status, 406);
const badSubscription = await handle(request("subscriptions/listen", { notifications: { toolsListChanged: "yes" } }));
assert.equal(badSubscription.status, 400);
const subscription = await handle(request("subscriptions/listen", { notifications: { toolsListChanged: true } }));
const subscriptionText = await subscription.text();
assert.equal(subscription.status, 200);
assert(subscriptionText.includes("notifications/subscriptions/acknowledged"));
assert(subscriptionText.includes('"resultType":"complete"'));

let resolveStream;
const streamController = new ModernMcpController({
  capabilities: { tools: {} }, serverInfo, instructions: "", supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
  discoveryTtlMs: 0, toolListTtlMs: 0, tools: () => [serverInfoTool, ...workspaceTools],
  recordError: (code) => errors.push(code), cancelClientRequest: async () => {},
  callTool: ({ signal }) => new Promise((resolve) => {
    resolveStream = () => resolve({ cancelled: signal.aborted });
  }),
});
const streamed = await streamController.handleRequest(input(request("tools/call", {
  name: "list_dir", arguments: { path: "." },
}), { proxyMode: "modern-direct", streamId: STREAM_ID }));
const streamReader = streamed.body.getReader();
assert.equal(new TextDecoder().decode((await streamReader.read()).value), ": connected\n\n");
await streamReader.cancel("client closed");
resolveStream();
await Promise.resolve();

const brokenController = new ModernMcpController({
  capabilities: { tools: {} }, serverInfo, instructions: "", supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
  discoveryTtlMs: 0, toolListTtlMs: 0,
  tools: () => { throw new Error("private dispatcher failure"); },
  recordError: (code) => errors.push(code), cancelClientRequest: async () => {}, callTool: async () => ({}),
});
const broken = await brokenController.handleRequest(input(request("tools/call", {
  name: "list_dir", arguments: { path: "." },
}), { proxyMode: "modern-direct", streamId: STREAM_ID }));
const brokenText = await broken.text();
assert(brokenText.includes('"code":-32603'));
assert(!brokenText.includes("private dispatcher failure"));
assert(errors.includes("modern_stream_dispatch_failed"));

console.log("modern MCP controller test ok");

async function handle(body, options = {}) {
  return controller.handleRequest(input(body, options));
}

function input(body, options = {}) {
  const headers = new Headers({ accept: options.accept ?? "application/json, text/event-stream" });
  if (options.streamId) {
    headers.set(MCP_STREAM_PROXY_MODE_HEADER, "modern-direct");
    headers.set(MCP_STREAM_PROXY_ID_HEADER, options.streamId);
  }
  return {
    request: new Request("https://example.test/mcp", { method: "POST", headers, body: "{}" }),
    body,
    base: "https://example.test",
    authorized,
    protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
    proxyMode: options.proxyMode ?? "",
  };
}

function request(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function controlRequest(streamId) {
  return new Request("https://example.test/mcp", {
    headers: {
      [MCP_STREAM_PROXY_MODE_HEADER]: "modern-cancel",
      [MCP_STREAM_PROXY_ID_HEADER]: streamId,
    },
  });
}

async function jsonResult(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}
