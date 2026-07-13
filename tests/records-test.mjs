import assert from "node:assert/strict";
import { isPlainRecord } from "../src/local/records.mjs";

assert.equal(isPlainRecord({}), true);
assert.equal(isPlainRecord(Object.create(null)), true);
assert.equal(isPlainRecord([]), false);
assert.equal(isPlainRecord(null), false);
assert.equal(isPlainRecord("record"), false);
assert.equal(isPlainRecord(new Date()), false);
assert.equal(isPlainRecord(new (class RecordLike {})()), false);
console.log("plain-record helper test ok");
