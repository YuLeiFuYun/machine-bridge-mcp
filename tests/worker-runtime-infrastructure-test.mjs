import { PendingCallRegistry } from "../src/worker/pending-calls.ts";
import { createMcpSessionId, validateMcpSessionId } from "../src/worker/mcp-session.ts";
import { daemonToolError, publicWorkerToolError, WorkerToolError } from "../src/worker/errors.ts";
import { policyAllowsAvailability, sanitizeDaemonPolicy, sanitizeDaemonTools } from "../src/worker/policy.ts";
import { WorkerObservability } from "../src/worker/observability.ts";

await testMcpSessions();
await testRequestKeyReuse();
await testRegistrationFailures();
await testTerminalPaths();
await testTimeoutCallbackFailure();
testWorkerPolicyParity();
testWorkerErrors();
testWorkerObservability();
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

async function testTimeoutCallbackFailure() {
  const registry = new PendingCallRegistry(1);
  const timedOut = registry.register({
    id: "timeout-callback", tool: "run_process", socket: {}, clientRequestKey: "timeout-key", timeoutMs: 1,
    onTimeout: () => { throw new Error("callback implementation failed"); },
  });
  await expectReject(timedOut, "pending daemon call timed out");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "throwing timeout callback leaked pending indexes");
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

function testWorkerErrors() {
  const structured = daemonToolError({ code: "limit_exceeded", message: "busy", retryable: true });
  assert(structured.code === "limit_exceeded" && structured.retryable, "daemon structured error was not preserved");
  const publicValue = publicWorkerToolError(structured);
  assert(publicValue.code === "limit_exceeded" && publicValue.message === "busy", "Worker public error lost stable fields");
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
  metrics.socketCandidate();
  metrics.socketAuthenticated();
  metrics.socketDisconnected();
  metrics.socketProtocolError("protocol_error");
  const snapshot = metrics.snapshot();
  assert(snapshot.requests.total === 3 && snapshot.requests.client_error === 1 && snapshot.requests.server_error === 1, "Worker request metrics are incomplete");
  assert(snapshot.calls.started === 2 && snapshot.calls.completed === 1 && snapshot.calls.failed === 1, "Worker call metrics are incomplete");
  assert(snapshot.errors.policy_denied === 1 && snapshot.errors.protocol_error === 1, "Worker error-code metrics are incomplete");
  assert(snapshot.tools.read_file.completed === 1 && snapshot.tools.write_file.failed === 1, "Worker per-tool metrics are incomplete");
  assert(snapshot.sockets.candidates === 1 && snapshot.sockets.authenticated === 1 && snapshot.sockets.disconnected === 1, "Worker socket metrics are incomplete");

  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    metrics.event("warn", "security.test", { access_token: "must-not-leak", path: "/mcp" });
  } finally {
    console.warn = originalWarn;
  }
  const event = JSON.parse(lines[0]);
  assert(event.access_token === "<redacted>" && !lines[0].includes("must-not-leak"), "Worker structured event leaked a sensitive field");
  assert(event.path === "/mcp", "Worker structured event removed a safe route field");
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
