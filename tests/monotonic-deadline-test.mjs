import assert from "node:assert/strict";
import test from "node:test";
import { createMonotonicDeadline } from "../src/local/core/timing.mjs";

test("monotonic deadline tracks remaining time monotonically and validates inputs", () => {
  let sample = 100;
  const deadline = createMonotonicDeadline(50, () => sample);
  assert.equal(deadline.remainingMs(), 50, "deadline did not start with the full duration");
  sample = 130;
  assert.equal(deadline.elapsedMs(), 30);
  assert.equal(deadline.remainingMs(), 20);
  assert.equal(deadline.expired(), false, "deadline did not advance with the monotonic clock");
  sample = 90;
  assert.equal(deadline.elapsedMs(), 30);
  assert.equal(deadline.remainingMs(), 20, "backward clock sample extended the deadline");
  sample = 151;
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.remainingMs(), 0, "deadline did not expire after the bounded duration");
  assert.throws(() => createMonotonicDeadline(-1), /non-negative/);
  assert.throws(() => createMonotonicDeadline(1, () => Number.NaN), /non-finite/);
});
