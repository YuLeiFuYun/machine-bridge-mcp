import { BridgeError } from "../src/local/errors.mjs";
import { LifecycleController } from "../src/local/lifecycle.mjs";

let now = 10;
const lifecycle = new LifecycleController("test-runtime", () => now++);
assert(lifecycle.snapshot().state === "ready" && lifecycle.snapshot().operational, "lifecycle did not start ready");
lifecycle.assertOperational();
assert(lifecycle.beginStart(), "ready lifecycle did not begin start");
assert(!lifecycle.snapshot().operational === false, "starting lifecycle should remain operational");
lifecycle.markRunning();
assert(lifecycle.snapshot().state === "running", "lifecycle did not become running");
assert(!lifecycle.beginStart(), "running start was not idempotent");
assert(lifecycle.beginStop(), "running lifecycle did not begin stop");
assert(!lifecycle.beginStop(), "duplicate stop was not idempotent");
lifecycle.markStopped();
assert(lifecycle.snapshot().state === "stopped" && !lifecycle.snapshot().operational, "lifecycle did not stop");
expectBridgeError(() => lifecycle.assertOperational(), "unavailable");
expectBridgeError(() => lifecycle.beginStart(), "conflict");

const failed = new LifecycleController("failed-runtime");
failed.beginStart();
failed.markFailed(new BridgeError("network_error", "offline"));
assert(failed.snapshot().state === "failed" && failed.snapshot().failure_code === "network_error", "failure state lost the stable code");
assert(failed.beginStart(), "failed lifecycle could not retry start");
failed.markRunning();
console.log("lifecycle controller test ok");

function expectBridgeError(operation, code) {
  try { operation(); } catch (error) {
    assert(error instanceof BridgeError && error.code === code, `expected BridgeError ${code}`);
    return;
  }
  throw new Error(`expected BridgeError ${code}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
