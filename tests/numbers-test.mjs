import assert from "node:assert/strict";
import test from "node:test";
import { clampInteger, nonNegativeInteger, positiveInteger } from "../src/shared/numbers.mjs";

test("shared integer normalization helpers normalize, clamp, and reject malformed inputs", () => {
  assert.equal(clampInteger(5, 3, 1, 10), 5);
  assert.equal(clampInteger(0, 3, 1, 10), 1);
  assert.equal(clampInteger(20, 3, 1, 10), 10);
  assert.equal(clampInteger("5", 3, 1, 10), 5);
  assert.equal(clampInteger("5junk", 3, 1, 10), 3);
  assert.equal(clampInteger("", 3, 1, 10), 3);
  assert.equal(clampInteger("  ", 3, 1, 10), 3);
  assert.equal(clampInteger(null, 3, 1, 10), 3);
  assert.equal(clampInteger(true, 3, 1, 10), 3);
  assert.equal(clampInteger(1.5, 3, 1, 10), 3);
  assert.equal(clampInteger(undefined, 3, 1, 10), 3);
  assert.equal(positiveInteger("7.9", 4), 7);
  assert.equal(positiveInteger(0, 4), 4);
  assert.equal(nonNegativeInteger("-1", 4), 4);
  assert.equal(nonNegativeInteger("2.9", 4), 2);
});
