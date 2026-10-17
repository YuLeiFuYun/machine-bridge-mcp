import assert from "node:assert/strict";
import fc from "fast-check";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { ProcessOutputStream } from "../src/local/process-output-stream.mjs";

const capacity = 128;
const chunk = Buffer.alloc(4 * 1024 * 1024, 120);
const stream = new ProcessOutputStream(capacity);
const output = new BoundedOutput(capacity, { headBytes: 40 });
const originalConcat = Buffer.concat;
try {
  Buffer.concat = (buffers, length) => {
    assert(buffers.reduce((sum, bytes) => sum + bytes.length, 0) <= capacity,
      "output append allocated discarded producer bytes");
    return originalConcat(buffers, length);
  };
  stream.append(chunk);
  output.append(chunk);
  output.append(chunk);
} finally { Buffer.concat = originalConcat; }
for (const bytes of [stream.buffer, output.head, output.tail]) {
  assert(bytes.buffer.byteLength <= Math.max(Buffer.poolSize * 2, capacity),
    "retained output kept an oversized backing allocation");
  assert.notEqual(bytes.buffer, chunk.buffer, "retained output aliases the producer allocation");
}
chunk.fill(121);
assert.equal(stream.read(0, capacity).data, "x".repeat(capacity));
assert(output.text().startsWith("x".repeat(40)) && output.text().endsWith("x".repeat(88)),
  "producer mutation changed a retained output snapshot");
assert.equal(stream.baseOffset, chunk.length - capacity);
assert.equal(output.truncatedBytes, chunk.length * 2 - capacity);

fc.assert(fc.property(
  fc.integer({ min: 1, max: 128 }),
  fc.array(fc.string({ unit: fc.constantFrom("a", "b", "c"), maxLength: 200 }), { maxLength: 25 }),
  (maximum, chunks) => {
    const all = Buffer.from(chunks.join(""));
    const retained = new ProcessOutputStream(maximum);
    const diagnostic = new BoundedOutput(maximum);
    for (const part of chunks) { retained.append(part); diagnostic.append(part); }
    const expected = all.subarray(Math.max(0, all.length - maximum));
    assert.deepEqual(retained.buffer, expected);
    assert.equal(retained.totalBytes, all.length);
    assert.equal(retained.baseOffset, all.length - expected.length);
    const read = retained.read(0, maximum);
    assert.equal(read.data, expected.toString());
    assert.equal(read.next_offset, all.length);
    if (all.length <= maximum) assert.equal(diagnostic.text(), all.toString());
    else {
      assert(diagnostic.text().startsWith(all.subarray(0, diagnostic.headLimit).toString()));
      if (diagnostic.tailLimit) assert(diagnostic.text().endsWith(all.subarray(-diagnostic.tailLimit).toString()));
      assert.equal(diagnostic.truncatedBytes, all.length - maximum);
    }
  },
), { numRuns: 200, seed: 201 });
console.log("output allocation bounds, ownership and partition properties ok");
