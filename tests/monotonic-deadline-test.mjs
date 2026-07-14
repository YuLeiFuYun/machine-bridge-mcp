import { createMonotonicDeadline } from "../src/local/monotonic-deadline.mjs";

let sample = 100;
const deadline = createMonotonicDeadline(50, () => sample);
assert(deadline.remainingMs() === 50, "deadline did not start with the full duration");
sample = 130;
assert(deadline.elapsedMs() === 30 && deadline.remainingMs() === 20 && !deadline.expired(), "deadline did not advance with the monotonic clock");
sample = 90;
assert(deadline.elapsedMs() === 30 && deadline.remainingMs() === 20, "backward clock sample extended the deadline");
sample = 151;
assert(deadline.expired() && deadline.remainingMs() === 0, "deadline did not expire after the bounded duration");
expectThrow(() => createMonotonicDeadline(-1), "non-negative");
expectThrow(() => createMonotonicDeadline(1, () => Number.NaN), "non-finite");
console.log("monotonic deadline test ok");

function expectThrow(operation, expected) {
  try { operation(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected error containing ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
