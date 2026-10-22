import { BridgeError } from "../../../src/local/errors.mjs";

export const PROCESS_FIXTURE_TIMEOUT_MS = 30_000;

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function assert(condition, message) { if (!condition) throw new Error(message || "assertion failed"); }

export function expectBridgeError(operation, code) {
  try { operation(); } catch (error) {
    assert(error instanceof BridgeError && error.code === code, `expected BridgeError ${code}`);
    return error;
  }
  throw new Error(`expected BridgeError ${code}`);
}

export async function expectReject(operation, code, message) {
  try { await operation(); } catch (error) {
    assert(error instanceof BridgeError, "tool executor leaked an untyped error");
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    assert(error.message.includes(message), `expected message containing ${message}`);
    return error;
  }
  throw new Error(`expected rejection ${code}`);
}
