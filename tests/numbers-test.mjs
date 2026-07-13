import assert from "node:assert/strict";
import { clampInteger } from "../src/local/numbers.mjs";

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
console.log("integer normalization helper test ok");
