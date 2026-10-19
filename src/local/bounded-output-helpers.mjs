// @ts-check

/** @param {{tailLimit: number, tailBuffer: Buffer, tailWriteOffset: number, tailBytes: number}} output @param {Buffer} bytes */
export function appendCircularTail(output, bytes) {
  if (!output.tailLimit || !bytes.length) return;
  if (bytes.length >= output.tailLimit) {
    output.tailBuffer.set(bytes.subarray(bytes.length - output.tailLimit));
    output.tailWriteOffset = 0;
    output.tailBytes = output.tailLimit;
    return;
  }
  const first = Math.min(bytes.length, output.tailLimit - output.tailWriteOffset);
  output.tailBuffer.set(bytes.subarray(0, first), output.tailWriteOffset);
  if (first < bytes.length) output.tailBuffer.set(bytes.subarray(first), 0);
  output.tailWriteOffset = (output.tailWriteOffset + bytes.length) % output.tailLimit;
  output.tailBytes = Math.min(output.tailLimit, output.tailBytes + bytes.length);
}

/** @param {Buffer} buffer @param {"head" | "tail"} side */
export function decodeUtf8Boundary(buffer, side) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const slice = side === "head"
      ? buffer.subarray(0, buffer.length - trim)
      : buffer.subarray(trim);
    try { return { text: decoder.decode(slice), bytes: slice.length }; } catch { /* try the next code-point boundary */ }
  }
  return { text: new TextDecoder("utf-8").decode(buffer), bytes: buffer.length };
}
