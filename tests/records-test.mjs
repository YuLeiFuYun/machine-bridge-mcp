import assert from "node:assert/strict";
import { isPlainRecord } from "../src/local/records.mjs";
import { isPlainRecord as isSharedPlainRecord } from "../src/shared/records.mjs";

assert.equal(isPlainRecord({}), true);
assert.equal(isPlainRecord(Object.create(null)), true);
assert.equal(isPlainRecord([]), false);
assert.equal(isPlainRecord(null), false);
assert.equal(isPlainRecord("record"), false);
assert.equal(isPlainRecord(new Date()), false);
assert.equal(isPlainRecord(new (class RecordLike {})()), false);
for (const value of [{}, Object.create(null), [], null, "record", new Date(), new (class RecordLike {})()]) {
  assert.equal(isSharedPlainRecord(value), isPlainRecord(value), "local compatibility export diverged from shared record validation");
}
console.log("shared plain-record helper test ok");
