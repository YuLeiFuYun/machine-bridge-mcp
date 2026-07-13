import { BridgeError, errorCode, publicError, remoteBridgeError } from "../src/local/errors.mjs";
import { CallRegistry } from "../src/local/call-registry.mjs";
import { RuntimeObservability } from "../src/local/observability.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { ToolExecutor, composeMiddleware } from "../src/local/tool-executor.mjs";

await testCallRegistry();
await testToolExecutor();
testProcessTracker();
testErrors();
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
  const executor = new ToolExecutor({
    handlers: {
      ok: async (args, context) => ({ value: args.value, call_id: context.callId }),
      fail: async () => { throw new Error("raw implementation failure"); },
    },
    policyGate: gate,
    callRegistry: registry,
    observability: metrics,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
    safeMessage: () => "safe failure",
  });
  const result = await executor.execute("ok", { value: 7 }, { callId: "ok-call", origin: "stdio" });
  assert(result.value === 7 && result.call_id === "ok-call", "tool executor lost arguments or lifecycle context");
  await expectReject(() => executor.execute("fail", {}, { callId: "fail-call", origin: "relay" }), "execution_failed", "safe failure");
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

function testProcessTracker() {
  const tracker = new ProcessTracker();
  const child = { pid: 0 };
  tracker.track(child, "call");
  assert(tracker.snapshot().active_processes === 1 && tracker.snapshot().calls_with_processes === 1, "process tracker did not register child ownership");
  tracker.releaseCall("call");
  assert(tracker.snapshot().active_processes === 1 && tracker.snapshot().calls_with_processes === 0, "call completion terminated or leaked call ownership");
  tracker.untrack(child);
  assert(tracker.snapshot().active_processes === 0, "process tracker did not release child");
}

function testErrors() {
  assert(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })) === "not_found", "Node error code classification failed");
  assert(errorCode(new Error("something timed out")) === "timeout", "legacy boundary classification failed");
  const publicValue = publicError(new BridgeError("network_error", "network unavailable"));
  assert(publicValue.code === "network_error" && publicValue.retryable === true, "public error lost retryability");
  const remote = remoteBridgeError({ code: "limit_exceeded", message: "busy", retryable: true });
  assert(remote.code === "limit_exceeded" && remote.retryable === true, "remote structured error was not preserved");
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
