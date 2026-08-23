import assert from "node:assert/strict";
import { McpController } from "../src/worker/mcp-controller.ts";
import {
  MAX_ACTIVE_MCP_SUBSCRIPTIONS, MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT,
  MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS, McpSubscriptionCapacity,
} from "../src/worker/mcp-subscription-capacity.ts";
import { McpSubscriptionRegistry } from "../src/worker/mcp-subscription-registry.ts";
import { McpRequestCancellationRegistry } from "../src/worker/mcp-request-cancellation.ts";
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

let cancellationClock = 1_000;
let cancellationFailClosedEvents = 0;
const requestCancellations = new McpRequestCancellationRegistry({
  now: () => cancellationClock, tombstoneTtlMs: 50, maximumTombstones: 2,
  onFailClosed: () => { cancellationFailClosedEvents += 1; },
});
assert.equal(requestCancellations.cancel("stream:cancel-before-open"), true);
const cancelledBeforeOpen = requestCancellations.open("stream:cancel-before-open", new AbortController().signal);
assert.equal(cancelledBeforeOpen.signal.aborted, true, "pre-open MCP cancellation did not bind to the later direct request");
cancelledBeforeOpen.release();
const liveCancellation = requestCancellations.open("stream:cancel-active", new AbortController().signal);
assert.equal(requestCancellations.cancel("stream:cancel-active"), true);
assert.equal(liveCancellation.signal.aborted, true, "active MCP cancellation did not abort the direct request lease");
liveCancellation.release();
const alreadyAbortedController = new AbortController();
alreadyAbortedController.abort("already gone");
const alreadyAbortedLease = requestCancellations.open("stream:already-aborted", alreadyAbortedController.signal);
assert.equal(alreadyAbortedLease.signal.aborted, true, "already-aborted request signal was lost while opening cancellation ownership");
alreadyAbortedLease.release();
requestCancellations.cancel("stream:expiring-cancel");
cancellationClock += 51;
assert.equal(requestCancellations.snapshot().cancelled_before_open, 0, "expired cancellation tombstone was retained indefinitely");
requestCancellations.cancel("stream:capacity-1");
requestCancellations.cancel("stream:capacity-2");
requestCancellations.cancel("stream:capacity-overflow");
requestCancellations.cancel("stream:capacity-overflow-again");
assert.equal(requestCancellations.snapshot().fail_closed, true,
  "pre-open cancellation tombstone overflow did not fail closed");
assert.equal(cancellationFailClosedEvents, 1,
  "one cancellation fail-closed window emitted duplicate observability events");
const overflowLease = requestCancellations.open("stream:unrelated-during-overflow", new AbortController().signal);
assert.equal(overflowLease.signal.aborted, true,
  "cancellation tombstone overflow evicted evidence and allowed an unrelated delayed side effect to dispatch");
overflowLease.release();
cancellationClock += 51;
assert.equal(requestCancellations.snapshot().fail_closed, false,
  "bounded cancellation overflow fail-closed state did not recover after its TTL");
requestCancellations.cancel("stream:capacity-3");
requestCancellations.cancel("stream:capacity-4");
requestCancellations.cancel("stream:capacity-overflow-later");
assert.equal(cancellationFailClosedEvents, 2,
  "a later cancellation fail-closed window did not emit fresh observability");
const controller = new McpController({
  capabilities: { tools: { listChanged: true } },
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
  name: "read_process", arguments: { session_id: "proc_synthetic", wait_ms: 5000 },
}), { accept: "application/json" }));
assert.equal(staleReadPollSchema.result.isError, true);
assert.equal(staleReadPollSchema.result.structuredContent.error.code, "invalid_request");
assert.equal(staleReadPollSchema.result.structuredContent.error.details.side_effects_started, false);
assert.equal(staleReadPollSchema.result.structuredContent.error.details.schema_refresh_recommended, true);
assert.equal(staleReadPollSchema.result.structuredContent.error.details.validation_issues[0].instancePath, "/wait_ms");
assert(staleReadPollSchema.result.structuredContent.error.message.includes("one-second limit")
  && staleReadPollSchema.result.structuredContent.error.message.includes("next_blocking_poll_after_ms")
  && staleReadPollSchema.result.structuredContent.error.message.includes("same MCP call")
  && staleReadPollSchema.result.structuredContent.error.message.includes("instead of rapid retrying")
  && staleReadPollSchema.result.structuredContent.error.message.includes("run_process/read_job")
  && !staleReadPollSchema.result.structuredContent.error.message.includes("short polling"),
"stale read_process compatibility guidance lost server-paced follow-up limits");
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
assert.deepEqual(controller.toolListSubscriptionSnapshot(authorized.accountId), {
  activeForAccount: 1, openedForAccount: true,
});
assert.match(subscription.headers.get("content-type") ?? "", /^text\/event-stream/);
const subscriptionReader = subscription.body.getReader();
const subscriptionMessages = await readSseMessages(subscriptionReader, 2);
assert.equal(subscriptionMessages.length, 2);
assert.equal(subscriptionMessages[0].method, "notifications/subscriptions/acknowledged");
assert.deepEqual(subscriptionMessages[0].params.notifications, { toolsListChanged: true });
assert.equal(subscriptionMessages[0].params._meta["io.modelcontextprotocol/subscriptionId"], 1);
assert.equal(subscriptionMessages[1].method, "notifications/tools/list_changed");
assert.equal(subscriptionMessages[1].params._meta["io.modelcontextprotocol/subscriptionId"], 1);
const pendingSubscriptionRead = subscriptionReader.read();
assert.equal(await Promise.race([
  pendingSubscriptionRead.then(() => "settled"),
  new Promise((resolve) => { setTimeout(() => resolve("open"), 20); }),
]), "open", "toolsListChanged subscription closed immediately after its initial freshness edge");
await subscriptionReader.cancel("test complete");
assert.equal((await pendingSubscriptionRead).done, true, "subscription cancellation did not settle the pending read");
assert.deepEqual(controller.toolListSubscriptionSnapshot(authorized.accountId), {
  activeForAccount: 0, openedForAccount: true,
}, "subscription diagnostics forgot that the server had opened a freshness stream for this account");
assert.deepEqual(controller.toolListSubscriptionSnapshot("different-account"), {
  activeForAccount: 0, openedForAccount: false,
}, "subscription diagnostics leaked another account's opened-stream state");

const proxiedSubscription = await handle(request("subscriptions/listen", {
  notifications: { toolsListChanged: true },
}, 2), { streamId: STREAM_ID, proxyMode: "direct" });
const proxiedSubscriptionReader = proxiedSubscription.body.getReader();
await readSseMessages(proxiedSubscriptionReader, 2);
const pendingProxiedRead = proxiedSubscriptionReader.read();
const proxiedCancel = await controller.handleControl(controlRequest(STREAM_ID), "cancel");
assert.equal(proxiedCancel.status, 202, "stream control cancellation rejected a live toolsListChanged subscription");
assert.equal((await pendingProxiedRead).done, true,
  "stream control cancellation did not close the live toolsListChanged subscription");
assert.deepEqual(controller.toolListSubscriptionSnapshot(authorized.accountId), {
  activeForAccount: 0, openedForAccount: true,
}, "stream control cancellation did not release subscription capacity while preserving opened-stream evidence");

const revokedSubscription = await handle(request("subscriptions/listen", {
  notifications: { toolsListChanged: true },
}, 3), { streamId: `${STREAM_ID.slice(0, -1)}B`, proxyMode: "direct" });
const revokedSubscriptionReader = revokedSubscription.body.getReader();
await readSseMessages(revokedSubscriptionReader, 2);
const pendingRevokedRead = revokedSubscriptionReader.read();
assert.equal(controller.cancelAuthority({
  accountId: authorized.accountId,
  accountVersion: authorized.accountVersion,
  clientId: authorized.clientId,
  familyId: "different-family",
}), 0, "subscription authority revocation matched a different refresh family");
assert.equal(controller.cancelAuthority({
  accountId: authorized.accountId,
  accountVersion: authorized.accountVersion,
  clientId: authorized.clientId,
  familyId: authorized.familyId,
}), 1, "subscription authority revocation did not cancel the matching long-lived stream");
assert.equal((await pendingRevokedRead).done, true,
  "subscription authority revocation did not close the matching response stream");
assert.deepEqual(controller.toolListSubscriptionSnapshot(authorized.accountId), {
  activeForAccount: 0, openedForAccount: true,
}, "subscription authority revocation leaked active capacity");
assert.equal(controller.cancelAuthority({
  accountId: authorized.accountId,
  accountVersion: authorized.accountVersion,
  clientId: authorized.clientId,
  familyId: authorized.familyId,
}), 0, "subscription authority revocation was not idempotent after stream cleanup");

const heldSubscriptions = [];
for (let index = 0; index < MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT; index += 1) {
  const held = await handle(request("subscriptions/listen", {
    notifications: { toolsListChanged: true },
  }, 10_000 + index));
  assert.equal(held.status, 200, "subscription capacity rejected a slot below the active-stream bound");
  heldSubscriptions.push(held);
}
const overCapacitySubscription = await handle(request("subscriptions/listen", {
  notifications: { toolsListChanged: true },
}, 11_000));
assert.equal(overCapacitySubscription.status, 429, "subscription capacity failed open above its active-stream bound");
assert.equal((await overCapacitySubscription.json()).error?.message, "Subscription capacity exceeded");
await heldSubscriptions[0].body.cancel("release capacity slot");
const recoveredSubscription = await handle(request("subscriptions/listen", {
  notifications: { toolsListChanged: true },
}, 11_001));
assert.equal(recoveredSubscription.status, 200, "subscription cancellation did not return its active-stream capacity slot");
await recoveredSubscription.body.cancel("test complete");
for (const held of heldSubscriptions.slice(1)) await held.body.cancel("test complete");

const capacity = new McpSubscriptionCapacity();
const capacityReleases = [];
for (const accountId of ["account-a", "account-b", "account-c", "account-d"]) {
  for (let index = 0; index < MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT; index += 1) {
    const release = capacity.reserve(accountId);
    assert.equal(typeof release, "function", "subscription capacity rejected a valid per-account/global slot");
    capacityReleases.push(release);
  }
  assert.equal(capacity.reserve(accountId), null, "subscription capacity failed to isolate one account at its per-account ceiling");
}
assert.equal(capacityReleases.length, MAX_ACTIVE_MCP_SUBSCRIPTIONS);
assert.equal(capacity.reserve("account-e"), null, "subscription capacity failed open beyond the global active-stream ceiling");
capacityReleases[0]();
capacityReleases[0]();
const recoveredGlobalSlot = capacity.reserve("account-e");
assert.equal(typeof recoveredGlobalSlot, "function", "idempotent release did not return exactly one global subscription slot");
assert.deepEqual(capacity.snapshot("account-e"), { activeForAccount: 1, openedForAccount: false });
capacity.markOpened("account-e");
assert.deepEqual(capacity.snapshot("account-e"), { activeForAccount: 1, openedForAccount: true });
recoveredGlobalSlot();
assert.deepEqual(capacity.snapshot("account-e"), { activeForAccount: 0, openedForAccount: true });
for (const release of capacityReleases.slice(1)) release();
for (let index = 0; index <= MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS; index += 1) {
  const accountId = `opened-${index}`;
  const release = capacity.reserve(accountId);
  assert.equal(typeof release, "function");
  capacity.markOpened(accountId);
  release();
}
assert.equal(capacity.snapshot("opened-0").openedForAccount, false,
  "subscription-open diagnostics retained an unbounded history of retired accounts");
assert.equal(capacity.snapshot(`opened-${MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS}`).openedForAccount, true,
  "bounded subscription-open diagnostics evicted the newest account");

const leasedRegistry = new McpSubscriptionRegistry({ leaseMs: 20 });
const leasedAbort = new AbortController();
const leasedResponse = leasedRegistry.open({
  authority: authorized,
  requestKey: "stream:leased-subscription",
  requestSignal: leasedAbort.signal,
  acknowledged: { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged" },
  initialMessages: [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }],
});
assert(leasedResponse?.body, "bounded subscription lease did not create an SSE response");
assert.deepEqual(leasedRegistry.snapshot(authorized.accountId), { activeForAccount: 1, openedForAccount: true },
  "bounded subscription lease did not reserve and mark its account");
const leasedReader = leasedResponse.body.getReader();
await readSseMessages(leasedReader, 2);
const leasedTerminal = leasedReader.read();
assert.equal((await Promise.race([
  leasedTerminal.then(() => "closed"),
  new Promise((resolve) => { setTimeout(() => resolve("leased"), 5); }),
])), "leased", "subscription lease expired before its configured lifetime");
await new Promise((resolve) => { setTimeout(resolve, 25); });
assert.equal((await leasedTerminal).done, true, "subscription lease did not close the stale SSE stream");
assert.deepEqual(leasedRegistry.snapshot(authorized.accountId), { activeForAccount: 0, openedForAccount: true },
  "subscription lease expiration did not release capacity while retaining server-opened evidence");

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

let preCancelledDispatches = 0;
const preCancelledController = new McpController({
  capabilities: { tools: {} }, serverInfo, instructions: "", supportedVersions: [MCP_PROTOCOL_VERSION],
  discoveryTtlMs: 0, toolListTtlMs: 0, tools: () => [serverInfoTool, ...workspaceTools],
  recordError: (code) => errors.push(code), cancelClientRequest: async () => {},
  callTool: async ({ signal }) => {
    if (signal.aborted) throw new WorkerToolError("cancelled", "cancelled before daemon dispatch", false, { side_effects_started: false });
    preCancelledDispatches += 1;
    return {};
  },
});
await preCancelledController.handleControl(controlRequest(STREAM_ID), "cancel");
const preCancelledResponse = await preCancelledController.handleRequest(input(request("tools/call", {
  name: "list_dir", arguments: { path: "." },
}), { proxyMode: "direct", streamId: STREAM_ID }));
await preCancelledResponse.text();
assert.equal(preCancelledDispatches, 0,
  "private cancellation that arrived before direct request ownership still reached the daemon dispatch gate");

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
    request: new Request("https://example.test/mcp", { method: "POST", headers, body: "{}", signal: options.signal }),
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

async function readSseMessages(reader, count) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const messages = sseJsonMessages(text);
    if (messages.length >= count) return messages.slice(0, count);
    const chunk = await reader.read();
    if (chunk.done) return messages;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function deepSubscriptionFilter(depth) {
  let value = { enabled: true };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}
