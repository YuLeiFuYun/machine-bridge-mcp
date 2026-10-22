// @ts-check

export class BoundedOutput {
  /** @param {unknown} maximumBytes @param {{headBytes?: number}} [options] */
  constructor(maximumBytes, options = {}) {
    const maximum = Number(maximumBytes);
    if (!Number.isFinite(maximum) || maximum < 1) throw new Error("maximum output bytes must be positive");
    this.maximum = Math.floor(maximum);
    this.headLimit = Math.max(1, Math.min(this.maximum, Math.floor(Number(options.headBytes) || this.maximum / 3)));
    this.tailLimit = Math.max(0, this.maximum - this.headLimit);
    this.totalBytes = 0;
    this.truncated = false;
    this.fullBuffer = Buffer.alloc(this.maximum);
    this.fullBytes = 0;
    this.head = Buffer.alloc(0);
    this.tailBuffer = Buffer.alloc(this.tailLimit);
    this.tailWriteOffset = 0;
    this.tailBytes = 0;
  }

  get full() {
    return this.truncated ? null : Buffer.from(this.fullBuffer.subarray(0, this.fullBytes));
  }

  get tail() {
    if (!this.tailLimit || !this.tailBytes) return Buffer.alloc(0);
    const start = (this.tailWriteOffset - this.tailBytes + this.tailLimit) % this.tailLimit;
    const end = start + this.tailBytes;
    if (end <= this.tailLimit) return Buffer.from(this.tailBuffer.subarray(start, end));
    return Buffer.concat([
      this.tailBuffer.subarray(start),
      this.tailBuffer.subarray(0, end - this.tailLimit),
    ], this.tailBytes);
  }

  /** @param {unknown} chunk */
  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!bytes.length) return;
    this.totalBytes += bytes.length;

    if (!this.truncated && this.fullBytes + bytes.length <= this.maximum) {
      this.fullBuffer.set(bytes, this.fullBytes);
      this.fullBytes += bytes.length;
      return;
    }

    if (!this.truncated) {
      const previous = this.fullBuffer.subarray(0, this.fullBytes);
      const missing = Math.max(0, this.headLimit - previous.length);
      this.head = Buffer.concat([previous.subarray(0, this.headLimit), bytes.subarray(0, missing)]);
      this.truncated = true;
      appendCircularTail(this, previous);
    }
    appendCircularTail(this, bytes);
  }

  get truncatedBytes() {
    if (!this.truncated) return 0;
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    return Math.max(0, this.totalBytes - head.bytes - tail.bytes);
  }

  text() {
    if (!this.truncated) return this.fullBuffer.subarray(0, this.fullBytes).toString("utf8");
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    const omitted = Math.max(0, this.totalBytes - head.bytes - tail.bytes);
    const marker = `\n\n[truncated ${omitted} bytes; preserved beginning and end]\n\n`;
    return `${head.text}${marker}${tail.text}`;
  }

}


/** @param {{tailLimit: number, tailBuffer: Buffer, tailWriteOffset: number, tailBytes: number}} output @param {Buffer} bytes */
function appendCircularTail(output, bytes) {
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
function decodeUtf8Boundary(buffer, side) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const slice = side === "head"
      ? buffer.subarray(0, buffer.length - trim)
      : buffer.subarray(trim);
    try { return { text: decoder.decode(slice), bytes: slice.length }; } catch { /* try the next code-point boundary */ }
  }
  return { text: new TextDecoder("utf-8").decode(buffer), bytes: buffer.length };
}
