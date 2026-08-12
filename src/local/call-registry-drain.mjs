import { BridgeError } from "./errors.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

const states = new WeakMap();

/** @typedef {{ calls: ReadonlyMap<string, unknown>, cancel: (callId: unknown, reason?: unknown, code?: string) => boolean }} DrainableCallRegistry */

export function assertCallRegistryOpen(registry) {
  if (!stateFor(registry).draining) return;
  throw new BridgeError("unavailable", "runtime is stopping and cannot accept new tool calls", { retryable: true });
}

/** @param {DrainableCallRegistry} registry @param {unknown} [reason] @param {number} [waitMs] */
export async function cancelAllCallsAndWait(registry, reason = "runtime stopped", waitMs = 5_000) {
  const state = stateFor(registry);
  state.draining = true;
  for (const id of [...registry.calls.keys()]) registry.cancel(id, reason);
  const deadline = createMonotonicDeadline(waitMs);
  while (registry.calls.size && !deadline.expired()) {
    await waitForRegistryChange(state, Math.max(1, deadline.remainingMs()));
  }
  if (registry.calls.size) {
    throw new BridgeError("unavailable", "tool call shutdown did not settle before the runtime teardown deadline", {
      retryable: true,
      details: { active_calls: registry.calls.size },
    });
  }
}

export function notifyCallRegistryChanged(registry) {
  for (const waiter of [...stateFor(registry).waiters]) waiter();
}

function stateFor(registry) {
  let state = states.get(registry);
  if (!state) {
    state = { draining: false, waiters: new Set() };
    states.set(registry, state);
  }
  return state;
}

function waitForRegistryChange(state, waitMs) {
  return new Promise((resolvePromise) => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      state.waiters.delete(done);
      resolvePromise();
    };
    state.waiters.add(done);
    timer = setTimeout(done, waitMs);
  });
}
