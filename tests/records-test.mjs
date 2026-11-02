import assert from "node:assert/strict";
import { asObject, isPlainRecord, isRecord } from "../src/shared/records.mjs";

assert.equal(isPlainRecord({}), true);
assert.equal(isPlainRecord(Object.create(null)), true);
assert.equal(isPlainRecord([]), false);
assert.equal(isPlainRecord(null), false);
assert.equal(isPlainRecord("record"), false);
assert.equal(isPlainRecord(new Date()), false);
assert.equal(isPlainRecord(new (class RecordLike {})()), false);
assert.equal(isRecord({}), true);
assert.equal(isRecord([]), false);
assert.equal(isRecord(null), false);
assert.deepEqual(asObject({ a: 1 }), { a: 1 });
assert.deepEqual(asObject(null), {});
assert.deepEqual(asObject([]), {});
assert.deepEqual(asObject("string"), {});
console.log("shared plain-record helper test ok");
