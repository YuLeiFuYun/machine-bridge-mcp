import { PendingCallRegistry } from "../src/worker/pending-calls.ts";
import { createMcpSessionId, validateMcpSessionId } from "../src/worker/mcp-session.ts";
import { acceptsEventStream, streamJsonRpcResponse } from "../src/worker/mcp-stream.ts";
import { daemonToolTimeoutMs } from "../src/worker/tool-timeout.ts";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../src/worker/policy.ts";
import { WorkerObservability } from "../src/worker/observability.ts";
import { searchParamsObject } from "../src/worker/http.ts";
import {
  asObject, isJsonRpcRequest, isJsonRpcResponse, requiredString, rpcError, rpcResult,
  sessionInstructionText, textToolResult, validateProtocolVersionHeader,
} from "../src/worker/mcp-jsonrpc.ts";
import {
  closeWebSocketQuietly, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly, trySendWebSocket,
} from "../src/worker/websocket-protocol.ts";
import {
  DAEMON_LIVENESS_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  isFreshDaemonCandidate,
  isLiveDaemonAttachment,
  withDaemonLastSeenAt,
} from "../src/worker/daemon-liveness.ts";

await testMcpSessions();
await testRequestKeyReuse();
await testRegistrationFailures();
await testTerminalPaths();
await testReconnectRebinding();
await testDetachedTimeoutPause();
await testTimeoutCallbackFailure();
await testAbortSignalCleanup();
await testMcpStreamResponse();
testRelayTimeoutContract();
testWorkerPolicyParity();
testWorkerErrors();
testWorkerObservability();
testPrototypeSafeFormFields();
testMcpJsonRpcProtocol();
testWebSocketProtocol();
testDaemonLiveness();
console.log("worker runtime infrastructure test ok");


async function testMcpSessions() {
  const identityKey = "identity-key-for-synthetic-worker-test";
  const tokenKey = "sha256:synthetic-token-key";
  const first = await createMcpSessionId(identityKey, tokenKey);
  const second = await createMcpSessionId(identityKey, tokenKey);
  assert(first !== second, "separate MCP initializations reused a session id");
  assert(await validateMcpSessionId(first, identityKey, tokenKey), "fresh MCP session id did not validate");
  assert(!(await validateMcpSessionId(first, identityKey, `${tokenKey}-other`)), "MCP session id was not bound to the OAuth token");
  assert(!(await validateMcpSessionId(tamperSessionId(first), identityKey, tokenKey)), "tampered MCP session id validated");
}

async function testRequestKeyReuse() {
  const socket = {};
  const registry = new PendingCallRegistry(2);
  const first = registry.register({
    id: "one", tool: "read_file", socket, clientRequestKey: "client:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(registry.hasRequestKey("client:1"), "request key was not indexed");
  assert(registry.snapshot().by_tool.read_file === 1, "pending snapshot omitted the active tool");
  assert(registry.resolve("one", socket, { ok: 1 }), "pending result was not resolved");
  assert((await first).ok === 1, "pending result value was lost");
  assert(!registry.hasRequestKey("client:1"), "resolved request key leaked");

  const reused = registry.register({
    id: "two", tool: "read_file", socket, clientRequestKey: "client:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  registry.resolve("two", socket, { ok: 2 });
  assert((await reused).ok === 2, "request id could not be reused immediately after completion");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "terminal resolution leaked pending indexes");
  assert(registry.snapshot().oldest_ms === 0 && Object.keys(registry.snapshot().by_tool).length === 0, "empty pending snapshot retained activity metadata");
}

async function testRegistrationFailures() {
  const socket = {};
  const conflictRegistry = new PendingCallRegistry(2);
  const original = conflictRegistry.register({
    id: "original", tool: "list_dir", socket, clientRequestKey: "session:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  expectRegistrationError(() => conflictRegistry.register({
    id: "duplicate", tool: "list_dir", socket, clientRequestKey: "session:1", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "conflict", false);
  conflictRegistry.resolve("original", socket, { ok: true });
  await original;

  const limitRegistry = new PendingCallRegistry(1);
  const first = limitRegistry.register({
    id: "first", tool: "run_process", socket, clientRequestKey: "session:2", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  expectRegistrationError(() => limitRegistry.register({
    id: "overflow", tool: "read_file", socket, clientRequestKey: "session:3", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  }), "limit_exceeded", true);
  limitRegistry.resolve("first", socket, { ok: true });
  await first;
}

async function testTerminalPaths() {
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(4);
  const cancelled = registry.register({
    id: "cancel", tool: "list_dir", socket: socketA, clientRequestKey: "cancel-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(registry.cancelRequest("cancel-key", () => new WorkerToolError("cancelled", "cancelled")), "cancel did not find request key");
  await expectReject(cancelled, "cancelled");
  assert(!registry.hasRequestKey("cancel-key"), "cancelled request key leaked");

  const disconnected = registry.register({
    id: "socket", tool: "list_dir", socket: socketA, clientRequestKey: "socket-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  const other = registry.register({
    id: "other", tool: "read_file", socket: socketB, clientRequestKey: "other-key", timeoutMs: 10_000,
    onTimeout: () => new Error("timeout"),
  });
  assert(registry.rejectSocket(socketA, () => new WorkerToolError("unavailable", "disconnected", true)) === 1, "socket cleanup rejected unrelated calls");
  await expectReject(disconnected, "disconnected");
  assert(registry.snapshot().active === 1 && registry.hasRequestKey("other-key"), "socket cleanup corrupted unrelated index");
  registry.reject("other", new Error("done"), socketB);
  await expectReject(other, "done");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "rejection leaked pending indexes");
}

async function testReconnectRebinding() {
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(2);
  const resumed = registry.register({
    id: "reconnect", tool: "exec_command", socket: socketA, daemonInstanceId: "daemon_same_instance_1234",
    clientRequestKey: "reconnect-key", timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
  });
  assert(registry.detachSocket(socketA, 1000, () => new WorkerToolError("unavailable", "reconnect grace expired", true)) === 1, "disconnect did not detach the active call");
  assert(registry.snapshot().detached === 1, "detached call was not visible in the pending snapshot");
  assert(registry.rebindInstance("daemon_other_instance_1234", socketB).length === 0, "different daemon instance stole a detached call");
  const reboundIds = registry.rebindInstance("daemon_same_instance_1234", socketB);
  assert(reboundIds.length === 1 && reboundIds[0] === "reconnect", "same daemon instance did not reclaim its detached call precisely");
  assert(registry.snapshot().detached === 0, "rebound call remained marked detached");
  assert(registry.resolve("reconnect", socketB, { resumed: true }), "rebound call rejected the replacement socket result");
  assert((await resumed).resumed === true, "rebound call lost its result");

  const expiring = registry.register({
    id: "expire", tool: "read_file", socket: socketA, daemonInstanceId: "daemon_expiring_instance_1",
    timeoutMs: 10_000, onTimeout: () => new Error("timeout"),
  });
  registry.detachSocket(socketA, 1, () => new WorkerToolError("unavailable", "reconnect grace expired", true));
  await expectReject(expiring, "reconnect grace expired");
  assert(registry.snapshot().active === 0, "expired detached call leaked from the pending registry");
}

async function testDetachedTimeoutPause() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const scheduler = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const advance = (duration) => {
    now += duration;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.deadline <= now)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  const socketA = {};
  const socketB = {};
  const registry = new PendingCallRegistry(1, { now: () => now, scheduler });
  const pending = registry.register({
    id: "paused-timeout", tool: "run_process", socket: socketA, daemonInstanceId: "daemon_pause_12345678",
    timeoutMs: 100, onTimeout: () => new Error("operation timeout"),
  });
  advance(40);
  assert(registry.detachSocket(socketA, 120, () => new Error("reconnect timeout")) === 1, "timeout-pause test did not detach its call");
  advance(100);
  assert(registry.snapshot().active === 1 && registry.snapshot().detached === 1, "normal operation timeout continued running while detached");
  assert(registry.rebindInstance("daemon_pause_12345678", socketB).length === 1, "detached timeout test did not rebind");
  advance(59);
  assert(registry.snapshot().active === 1, "rebound operation timeout lost its remaining budget");
  advance(1);
  await expectReject(pending, "operation timeout");
  assert(registry.snapshot().active === 0, "expired rebound call leaked from the registry");
}

async function testTimeoutCallbackFailure() {
  const registry = new PendingCallRegistry(1);
  const timedOut = registry.register({
    id: "timeout-callback", tool: "run_process", socket: {}, clientRequestKey: "timeout-key", timeoutMs: 1,
    onTimeout: () => { throw new Error("callback implementation failed"); },
  });
  await expectReject(timedOut, "pending daemon call timed out");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "throwing timeout callback leaked pending indexes");
}

async function testMcpStreamResponse() {
  assert(acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "application/json, text/event-stream" } })), "event-stream content negotiation was not detected");
  assert(!acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "application/json" } })), "JSON-only client was incorrectly upgraded to SSE");
  assert(!acceptsEventStream(new Request("https://example.test/mcp", { headers: { accept: "text/event-stream; q=0, application/json" } })), "explicitly unacceptable event stream was selected");

  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let intervalCallback = null;
  let intervalCleared = false;
  let keptAlive = null;
  const response = streamJsonRpcResponse(result, {
    streamId: "stream_test",
    heartbeatMs: 1,
    scheduler: {
      setInterval(callback) { intervalCallback = callback; return 1; },
      clearInterval(handle) { if (handle === 1) intervalCleared = true; },
    },
    keepAlive(promise) { keptAlive = promise; },
  });
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"), "stream response did not advertise SSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await reader.read()).value);
  assert(initial === ": connected\n\n", "stream response did not prime the client with a non-message frame");
  intervalCallback();
  const heartbeat = decoder.decode((await reader.read()).value);
  assert(heartbeat === ": keepalive\n\n", "stream response heartbeat was malformed");
  resolveResult({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  const terminal = decoder.decode((await reader.read()).value);
  assert(terminal.includes("event: message") && terminal.includes('"id":7') && terminal.includes('"ok":true'), "stream response lost the terminal JSON-RPC result");
  assert((await reader.read()).done, "stream response did not close after the terminal result");
  await keptAlive;
  assert(intervalCleared, "stream response heartbeat timer was not cleared");

  let resolveDisconnected;
  const disconnectedResult = new Promise((resolve) => { resolveDisconnected = resolve; });
  let disconnectedCompletion = null;
  const disconnected = streamJsonRpcResponse(disconnectedResult, {
    streamId: "stream_disconnected",
    scheduler: { setInterval() { return 2; }, clearInterval() {} },
    keepAlive(promise) { disconnectedCompletion = promise; },
  });
  const disconnectedReader = disconnected.body.getReader();
  await disconnectedReader.read();
  await disconnectedReader.cancel();
  resolveDisconnected({ jsonrpc: "2.0", id: 8, result: { ok: true } });
  await disconnectedCompletion;
}

async function testAbortSignalCleanup() {
  const registry = new PendingCallRegistry(1);
  const controller = new AbortController();
  let cancelledId = "";
  const cancelled = registry.register({
    id: "request-abort", tool: "list_dir", socket: {}, clientRequestKey: "abort-key", timeoutMs: 10_000,
    signal: controller.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: (record) => {
      cancelledId = record.id;
      return new WorkerToolError("cancelled", "client stopped waiting");
    },
  });
  assert(registry.snapshot().active === 1 && registry.hasRequestKey("abort-key"), "abortable call was not registered");
  controller.abort();
  await expectReject(cancelled, "client stopped waiting");
  assert(cancelledId === "request-abort", "abort callback received the wrong pending call");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "request abort leaked pending indexes");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const rejectedImmediately = registry.register({
    id: "already-aborted", tool: "list_dir", socket: {}, timeoutMs: 10_000,
    signal: alreadyAborted.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: () => new WorkerToolError("cancelled", "already cancelled"),
  });
  await expectReject(rejectedImmediately, "already cancelled");
  assert(registry.snapshot().active === 0, "already-aborted request entered the pending registry");
}

function testRelayTimeoutContract() {
  assert(relayContract.reconnectGraceMs === 120_000, "relay reconnect grace drifted from the incident-tested budget");
  assert(relayContract.streamHeartbeatMs === 10_000, "SSE heartbeat interval drifted from the idle-connection contract");
  assert(daemonToolTimeoutMs("session_bootstrap", {}) === 10_000, "bootstrap timeout incorrectly inherited the reconnect budget");
  assert(daemonToolTimeoutMs("read_file", {}) === 60_000, "ordinary tool timeout was extended without a disconnect");
  assert(daemonToolTimeoutMs("exec_command", { timeout_seconds: 120 }) === 125_000, "configurable tool timeout lost its protocol overhead");
  assert(daemonToolTimeoutMs("exec_command", { timeout_seconds: 600 }) === 605_000, "maximum configurable execution timeout drifted from the relay contract");
  assert(relayContract.maximumRelayToolTimeoutMs === 610_000, "local relay envelope ceiling drifted from the Worker contract");
}

function testWorkerPolicyParity() {
  const review = sanitizeDaemonPolicy({ profile: "review", origin: "explicit", revision: 4, allowWrite: false, execMode: "off" });
  const agent = sanitizeDaemonPolicy({ profile: "agent", origin: "explicit", revision: 4, allowWrite: true, execMode: "direct" });
  const noWriteDirect = sanitizeDaemonPolicy({ profile: "custom", origin: "custom", revision: 4, allowWrite: false, execMode: "direct" });
  assert(policyAllowsAvailability(review, "always"), "Worker review lost always tools");
  assert(!policyAllowsAvailability(review, "write"), "Worker review gained writes");
  assert(policyAllowsAvailability(agent, "write+direct-exec"), "Worker agent lost compound capability");
  assert(!policyAllowsAvailability(noWriteDirect, "write+direct-exec"), "Worker custom no-write policy can start jobs");
  const reviewTools = new Set(sanitizeDaemonTools(["read_file", "write_file", "list_jobs", "start_job"], review));
  assert(reviewTools.has("read_file") && reviewTools.has("list_jobs"), "Worker removed read-only tools from review");
  assert(!reviewTools.has("write_file") && !reviewTools.has("start_job"), "Worker accepted denied tools from daemon hello");
}

function testPrototypeSafeFormFields() {
  const value = searchParamsObject(new URLSearchParams("constructor=first&constructor=second&__proto__=plain"));
  assert(Object.getPrototypeOf(value) === null, "form field aggregation retained Object.prototype");
  assert(Array.isArray(value.constructor) && value.constructor.join(",") === "first,second", "constructor form field was not treated as ordinary data");
  assert(value.__proto__ === "plain", "__proto__ form field was not treated as ordinary data");
}

function testMcpJsonRpcProtocol() {
  const request = { jsonrpc: "2.0", id: "request-1", method: "tools/list", params: {} };
  assert(isJsonRpcRequest(request), "valid JSON-RPC request was rejected");
  assert(!isJsonRpcRequest({ ...request, method: "" }), "empty JSON-RPC method was accepted");
  assert(!isJsonRpcRequest({ ...request, id: Number.POSITIVE_INFINITY }), "non-finite JSON-RPC id was accepted");
  assert(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} }), "valid JSON-RPC response was rejected");
  assert(!isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {}, error: {} }), "ambiguous JSON-RPC response was accepted");
  assert(rpcResult(undefined, {}) === null, "JSON-RPC notification unexpectedly produced a response");
  assert(rpcResult(null, { ok: true })?.id === null, "JSON-RPC null id was not preserved");
  assert(rpcError(undefined, -32600, "invalid").id === null, "JSON-RPC error omitted the null fallback id");
  const structured = textToolResult({ $mcp: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } });
  assert(structured.structuredContent?.ok === true, "special MCP tool result lost structured content");
  const ordinary = textToolResult({ ok: true });
  assert(ordinary.structuredContent?.ok === true && ordinary.content[0].type === "text", "ordinary tool result lost text or structured content");
  assert(Object.keys(asObject(null)).length === 0, "non-object params were not normalized");
  assert(requiredString({ name: " read_file " }, "name") === "read_file", "required string was not normalized");
  expectThrow(() => requiredString({}, "name"), "non-empty string");
  assert(sessionInstructionText({ instructions: "local guidance" }) === "local guidance", "session instructions were not extracted");
  assert(sessionInstructionText({ instructions: "x".repeat(3 * 1024 * 1024 + 1) }) === "", "oversized session instructions were accepted");
  const supported = ["2025-11-25"];
  const initialize = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": "unsupported" } });
  assert(validateProtocolVersionHeader(initialize, { ...request, method: "initialize" }, supported) === null, "initialize was rejected before protocol negotiation");
  const accepted = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": supported[0] } });
  assert(validateProtocolVersionHeader(accepted, request, supported) === null, "supported MCP protocol header was rejected");
  const rejected = new Request("https://example.test/mcp", { headers: { "MCP-Protocol-Version": "unsupported" } });
  assert(validateProtocolVersionHeader(rejected, request, supported)?.error?.code === -32602, "unsupported MCP protocol header did not return the expected error");
}

function testWebSocketProtocol() {
  const trySent = [];
  assert(trySendWebSocket({ send(value) { trySent.push(value); } }, { type: "pong" }) === true, "successful WebSocket send was reported as failed");
  assert(JSON.parse(trySent[0]).type === "pong", "WebSocket send helper serialized the wrong payload");
  assert(trySendWebSocket({ send() { throw new Error("closed"); } }, { type: "pong" }) === false, "failed WebSocket send was reported as successful");
  const sent = [];
  const closed = [];
  const socket = {
    send(value) { sent.push(value); },
    close(code, reason) { closed.push({ code, reason }); },
  };
  assert(isObjectRecord({ type: "hello" }) && !isObjectRecord([]) && !isObjectRecord(null), "daemon record guard accepted an invalid shape");
  sendWebSocketQuietly(socket, { type: "pong" });
  rejectDaemonMessage(socket, "invalid_message", 1002, "invalid daemon message");
  closeWebSocketQuietly(socket, 1000, "done");
  assert(JSON.parse(sent[0]).type === "pong" && JSON.parse(sent[1]).error === "invalid_message", "WebSocket protocol helper lost payloads");
  assert(closed[0].code === 1002 && closed[1].code === 1000, "WebSocket close helper lost close metadata");
  const throwing = { send() { throw new Error("closed"); }, close() { throw new Error("closed"); } };
  sendWebSocketQuietly(throwing, "ignored");
  closeWebSocketQuietly(throwing);
}

function testWorkerErrors() {
  const structured = daemonToolError({
    code: "limit_exceeded", message: "busy", retryable: true,
    details: { process: { output_session_id: "proc_worker_detail_123456789012" } },
  });
  assert(structured.code === "limit_exceeded" && structured.retryable, "daemon structured error was not preserved");
  const publicValue = publicWorkerToolError(structured);
  assert(publicValue.code === "limit_exceeded" && publicValue.message === "busy", "Worker public error lost stable fields");
  assert(publicValue.details?.process?.output_session_id === "proc_worker_detail_123456789012", "Worker error adapter lost safe process continuation details");
  const unknown = daemonToolError({ code: "caller_defined_code", message: "unsupported" });
  assert(unknown.code === "execution_failed", "Worker accepted an unregistered daemon error code");
  const directUnknown = new WorkerToolError("future_custom_code", "unsupported");
  assert(directUnknown.code === "execution_failed", "WorkerToolError accepted an unregistered direct code");
  const hidden = publicWorkerToolError(new Error("private internal details"));
  assert(hidden.message === "tool execution failed" && !hidden.message.includes("private"), "Worker exposed raw internal exception text");
}

function testWorkerObservability() {
  const metrics = new WorkerObservability();
  metrics.requestFinished(200);
  metrics.requestFinished(403);
  metrics.requestFinished(503);
  metrics.callStarted("read_file");
  metrics.callFinished("read_file");
  metrics.callStarted("write_file");
  metrics.callFinished("write_file", "policy_denied");
  metrics.unmatchedResult();
  metrics.socketCandidate();
  metrics.socketAuthenticated();
  metrics.socketDisconnected();
  metrics.socketProtocolError("protocol_error");
  const snapshot = metrics.snapshot();
  assert(snapshot.requests.total === 3 && snapshot.requests.client_error === 1 && snapshot.requests.server_error === 1, "Worker request metrics are incomplete");
  assert(snapshot.calls.started === 2 && snapshot.calls.completed === 1 && snapshot.calls.failed === 1, "Worker call metrics are incomplete");
  assert(snapshot.calls.unmatched_results === 1, "Worker unmatched-result metric was not retained");
  assert(snapshot.errors.policy_denied === 1 && snapshot.errors.protocol_error === 1, "Worker error-code metrics are incomplete");
  assert(snapshot.tools.read_file.completed === 1 && snapshot.tools.write_file.failed === 1, "Worker per-tool metrics are incomplete");
  assert(snapshot.sockets.candidates === 1 && snapshot.sockets.authenticated === 1 && snapshot.sockets.disconnected === 1, "Worker socket metrics are incomplete");

  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    metrics.event("warn", "security.test", {
      access_token: "must-not-leak",
      path: "/mcp",
      detail: "Bearer abcdefghijklmnopqrstuvwxyz for operator@example.com under /Users/example/private",
      level: "info",
      component: "caller",
      event: "caller.override",
      timestamp: "1970-01-01T00:00:00.000Z",
    });
  } finally {
    console.warn = originalWarn;
  }
  const event = JSON.parse(lines[0]);
  assert(event.access_token === "<redacted>" && !lines[0].includes("must-not-leak"), "Worker structured event leaked a sensitive field");
  assert(event.path === "/mcp", "Worker structured event removed a safe route field");
  assert(!lines[0].includes("abcdefghijklmnopqrstuvwxyz") && !lines[0].includes("operator@example.com") && !lines[0].includes("/Users/example"), "Worker structured event leaked a sensitive value embedded in a non-sensitive field");
  assert(event.detail.includes("Bearer <redacted>") && event.detail.includes("<redacted-email>") && event.detail.includes("<home>"), "Worker structured event did not retain redaction markers");
  assert(event.level === "warn" && event.component === "worker" && event.event === "security.test" && event.timestamp !== "1970-01-01T00:00:00.000Z", "Worker event fields overrode authoritative log metadata");
}

function tamperSessionId(value) {
  const signatureStart = value.lastIndexOf("_") + 1;
  const replacement = value[signatureStart] === "A" ? "B" : "A";
  return `${value.slice(0, signatureStart)}${replacement}${value.slice(signatureStart + 1)}`;
}

function expectRegistrationError(operation, code, retryable) {
  try { operation(); } catch (error) {
    assert(error?.code === code && error?.retryable === retryable, `expected pending registration error ${code}`);
    return;
  }
  throw new Error(`expected pending registration error ${code}`);
}

async function expectReject(promise, expected) {
  try { await promise; } catch (error) { assert(String(error?.message || error).includes(expected), `expected ${expected}`); return; }
  throw new Error(`expected rejection containing ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function expectThrow(operation, expected) { try { operation(); } catch (error) { assert(String(error?.message || error).includes(expected), `expected ${expected}`); return; } throw new Error(`expected throw containing ${expected}`); }

function testDaemonLiveness() {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  assert(isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 1_000).toISOString(),
    lastSeenAt: new Date(now - 1_000).toISOString(),
  }, now), "fresh heartbeat should keep daemon live");
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 120_000).toISOString(),
    lastSeenAt: new Date(now - 120_000).toISOString(),
  }, now), "silent authenticated socket must not stay live");
  assert(!isLiveDaemonAttachment({
    role: "candidate",
    connectedAt: new Date(now).toISOString(),
  }, now), "candidates are not live daemons");
  assert(isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 30_000).toISOString(),
  }, now), "legacy attachments without lastSeenAt fall back to connectedAt");
  assert(!isLiveDaemonAttachment({
    role: "daemon",
    connectedAt: new Date(now - 120_000).toISOString(),
  }, now), "legacy silent attachments without lastSeenAt must not stay live");
  assert(daemonLivenessDeadlineMs({
    role: "daemon",
    connectedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  }) === now + DAEMON_LIVENESS_TIMEOUT_MS, "liveness deadline must be lastSeen + timeout");
  assert(isFreshDaemonCandidate(new Date(now - 1_000).toISOString(), now), "fresh candidate should be accepted");
  assert(!isFreshDaemonCandidate(new Date(now - 20_000).toISOString(), now), "stale candidate should be rejected");
  const touched = withDaemonLastSeenAt({
    role: "daemon",
    connectedAt: "2026-07-17T11:00:00.000Z",
  }, "2026-07-17T12:00:00.000Z");
  assert(touched.lastSeenAt === "2026-07-17T12:00:00.000Z", "lastSeenAt helper did not preserve timestamp");
}
