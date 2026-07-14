import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BridgeError, errorCode, publicError, remoteBridgeError } from "../src/local/errors.mjs";
import { CallRegistry } from "../src/local/call-registry.mjs";
import { RuntimeObservability } from "../src/local/observability.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { ToolExecutor, composeMiddleware } from "../src/local/tool-executor.mjs";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";

await testCallRegistry();
await testToolExecutor();
await testProcessCancellationSettlesBeforeClose();
testProcessTracker();
testErrors();
testBoundedOutput();
console.log("runtime infrastructure test ok");

async function testCallRegistry() {
  const timers = new Map();
  let nextTimer = 1;
  const cancelled = [];
  const registry = new CallRegistry({
    maximum: 2,
    now: () => 100,
    scheduler: {
      setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    onCancel(record) { cancelled.push({ id: record.id, reason: record.cancelReason }); },
  });
  const first = registry.open({ callId: "one", tool: "read_file", origin: "stdio", timeoutMs: 50 });
  registry.open({ callId: "two", tool: "git_status", origin: "relay" });
  expectBridgeError(() => registry.open({ callId: "three" }), "limit_exceeded");
  expectBridgeError(() => registry.open({ callId: "one" }), "conflict");
  [...timers.values()][0]();
  expectBridgeError(() => registry.throwIfCancelled(first), "timeout");
  assert(cancelled[0]?.reason === "deadline exceeded", "deadline did not use the central cancellation path");
  assert(registry.snapshot().active === 2, "cancelled call vanished before lifecycle finish");
  registry.finish("one");
  assert(registry.cancelOrigin("relay", "relay disconnected") === 1, "relay origin cancellation did not find its call");
  assert(cancelled.at(-1)?.reason === "relay disconnected", "relay origin cancellation lost its reason");
  registry.finish("two");
  assert(registry.snapshot().active === 0, "finished calls leaked from registry");
  registry.open({ callId: "stop-one", tool: "read_file" });
  registry.open({ callId: "stop-two", tool: "git_status" });
  registry.cancelAll("runtime stopped");
  assert(registry.snapshot().active === 0, "cancelAll left stopped calls registered");
}

async function testToolExecutor() {
  const events = [];
  const metrics = new RuntimeObservability({ now: () => 1000 });
  const registry = new CallRegistry({ maximum: 4 });
  const gate = { assert(name) { if (name === "denied") throw new BridgeError("policy_denied", "denied"); } };
  const accountAccessGate = { assert(role, name) { if (role !== "owner" || name === "account-denied") throw new BridgeError("policy_denied", "account denied"); } };
  const executor = new ToolExecutor({
    handlers: {
      ok: async (args, context) => ({ value: args.value, call_id: context.callId }),
      fail: async () => { throw new Error("raw implementation failure"); },
    },
    policyGate: gate,
    accountAccessGate,
    callRegistry: registry,
    observability: metrics,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
    safeMessage: () => "safe failure",
  });
  const result = await executor.execute("ok", { value: 7 }, { callId: "ok-call", origin: "stdio" });
  assert(result.value === 7 && result.call_id === "ok-call", "tool executor lost arguments or lifecycle context");
  await expectReject(() => executor.execute("fail", {}, { callId: "fail-call", origin: "relay", authorization: { role: "owner" } }), "execution_failed", "safe failure");
  await expectReject(() => executor.execute("denied", {}, { callId: "deny-call" }), "policy_denied", "denied");
  const snapshot = metrics.snapshot();
  assert(snapshot.calls.started === 3, "authorization attempts are missing from execution metrics");
  assert(snapshot.calls.completed === 1 && snapshot.calls.failed === 2, "tool metrics lost terminal outcomes");
  assert(snapshot.errors.execution_failed === 1 && snapshot.errors.policy_denied === 1, "tool metrics lost stable error codes");
  assert(events.some((event) => event.name === "tool.call.started") && events.some((event) => event.name === "tool.call.failed"), "structured lifecycle events were not emitted");
  assert(registry.snapshot().active === 0, "tool executor leaked call lifecycle state");

  const order = [];
  const pipeline = composeMiddleware([
    async (operation, next) => { order.push("a-before"); const value = await next(operation); order.push("a-after"); return value; },
    async (operation, next) => { order.push("b-before"); const value = await next(operation); order.push("b-after"); return value; },
  ], async () => { order.push("handler"); return true; });
  await pipeline({});
  assert(order.join(",") === "a-before,b-before,handler,b-after,a-after", "middleware composition order is invalid");
}

async function testProcessCancellationSettlesBeforeClose() {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4242;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.stdin = new PassThrough();
    }
  }
  const child = new NeverClosingChild();
  let terminated = 0;
  const tracker = new ProcessTracker({ terminateWithEscalation() { terminated += 1; } });
  const service = new ProcessExecutionService({
    workspace: process.cwd(),
    policy: { minimalEnv: false },
    policyGate: { assert() {} },
    runtimeDir: process.cwd(),
    processTracker: tracker,
    resolveExistingPath: async (value) => value,
    resolveLocalCommand: async () => ({}),
    displayPath: (value) => value,
    throwIfCancelled(context) { if (context.signal?.aborted) throw context.signal.reason; },
    spawnProcess: () => child,
    terminateProcess: () => { terminated += 1; return null; },
  });
  const controller = new AbortController();
  const running = service.run("never", [], 60_000, false, 1024, { callId: "stuck", signal: controller.signal });
  controller.abort(new BridgeError("cancelled", "relay disconnected"));
  await expectReject(() => Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation did not settle")), 100))]), "cancelled", "relay disconnected");
  assert(terminated === 1, "cancelled process was not terminated");
  assert(tracker.snapshot().active_processes === 1, "process tracker released a child before close");
  child.emit("close", null);
  assert(tracker.snapshot().active_processes === 0, "process tracker retained child after close");
}

function testProcessTracker() {
  const terminations = [];
  const escalations = [];
  const tracker = new ProcessTracker({
    terminate(child, signal) { terminations.push({ child, signal }); },
    terminateWithEscalation(child) { escalations.push(child); },
  });
  const first = { pid: 101 };
  const second = { pid: 102 };
  const unowned = { pid: 103 };
  tracker.track(null, "ignored");
  tracker.track(first, "call");
  tracker.track(second, "call");
  tracker.track(unowned);
  assert(tracker.snapshot().active_processes === 3 && tracker.snapshot().calls_with_processes === 1, "process tracker did not register child ownership");

  assert(tracker.terminateCall("call") === 2 && escalations.length === 2, "graceful call termination did not escalate owned children");
  assert(tracker.terminateCall("call", { force: true }) === 2, "forced call termination lost owned children");
  assert(terminations.length === 2 && terminations.every((entry) => entry.signal === "SIGKILL"), "forced call termination did not use SIGKILL");
  assert(tracker.terminateCall("missing") === 0, "missing call reported terminated children");

  tracker.terminateAll("SIGTERM", true);
  assert(escalations.length === 5, "terminateAll escalation did not cover every active child");
  tracker.terminateAll("SIGKILL", true);
  assert(terminations.slice(-3).every((entry) => entry.signal === "SIGKILL"), "SIGKILL terminateAll incorrectly used escalation");
  tracker.terminateAll("SIGTERM", false);
  assert(terminations.slice(-3).every((entry) => entry.signal === "SIGTERM"), "non-escalating terminateAll changed the signal");

  tracker.releaseCall("call");
  tracker.releaseCall("");
  assert(tracker.snapshot().active_processes === 3 && tracker.snapshot().calls_with_processes === 0, "call completion terminated or leaked call ownership");
  tracker.untrack(first);
  tracker.untrack(second);
  tracker.untrack(unowned);
  tracker.untrack(null);
  assert(tracker.snapshot().active_processes === 0, "process tracker did not release children");
}

function testErrors() {
  assert(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })) === "not_found", "Node error code classification failed");
  assert(errorCode(new Error("something timed out")) === "execution_failed", "untyped messages must not be reclassified heuristically");
  const publicValue = publicError(new BridgeError("network_error", "network unavailable"));
  assert(publicValue.code === "network_error" && publicValue.retryable === true, "public error lost retryability");
  const remote = remoteBridgeError({ code: "limit_exceeded", message: "busy", retryable: true });
  assert(remote.code === "limit_exceeded" && remote.retryable === true, "remote structured error was not preserved");
}

function testBoundedOutput() {
  const output = new BoundedOutput(12, { headBytes: 5 });
  output.append("BEGIN-");
  output.append("middle-middle-");
  output.append("-END");
  const text = output.text();
  assert(text.startsWith("BEGIN"), "bounded output lost the beginning");
  assert(text.endsWith("le--END"), "bounded output lost the diagnostic tail");
  assert(text.includes("preserved beginning and end"), "bounded output omitted truncation semantics");
  assert(output.truncatedBytes > 0, "bounded output did not count omitted bytes");
}

async function expectReject(operation, code, message) {
  try { await operation(); } catch (error) {
    assert(error instanceof BridgeError, "tool executor leaked an untyped error");
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    assert(error.message.includes(message), `expected message containing ${message}`);
    return;
  }
  throw new Error(`expected rejection ${code}`);
}
function expectBridgeError(operation, code) {
  try { operation(); } catch (error) { assert(error instanceof BridgeError && error.code === code, `expected BridgeError ${code}`); return; }
  throw new Error(`expected BridgeError ${code}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
