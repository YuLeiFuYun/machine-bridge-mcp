export class BoundedOutput {
  constructor(maximumBytes, options = {}) {
    const maximum = Number(maximumBytes);
    if (!Number.isFinite(maximum) || maximum < 1) throw new Error("maximum output bytes must be positive");
    this.maximum = Math.floor(maximum);
    this.headLimit = Math.max(1, Math.min(this.maximum, Math.floor(Number(options.headBytes) || this.maximum / 3)));
    this.tailLimit = Math.max(0, this.maximum - this.headLimit);
    this.totalBytes = 0;
    this.full = Buffer.alloc(0);
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
  }

  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!bytes.length) return;
    this.totalBytes += bytes.length;

    if (this.full && this.full.length + bytes.length <= this.maximum) {
      this.full = Buffer.concat([this.full, bytes]);
      return;
    }

    const previous = this.full || this.tail;
    if (this.full) {
      const missing = Math.max(0, this.headLimit - this.full.length);
      this.head = Buffer.concat([this.full.subarray(0, this.headLimit), bytes.subarray(0, missing)]);
      this.full = null;
    }
    if (this.tailLimit) {
      // Copy only retained bytes; subarray alone keeps the entire producer chunk alive.
      const tail = bytes.subarray(Math.max(0, bytes.length - this.tailLimit));
      const retained = Math.min(previous.length, this.tailLimit - tail.length);
      this.tail = Buffer.concat([previous.subarray(previous.length - retained), tail]);
    }
  }

  get truncatedBytes() {
    if (this.full) return 0;
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    return Math.max(0, this.totalBytes - head.bytes - tail.bytes);
  }

  text() {
    if (this.full) return this.full.toString("utf8");
    const head = decodeUtf8Boundary(this.head, "head");
    const tail = decodeUtf8Boundary(this.tail, "tail");
    const omitted = Math.max(0, this.totalBytes - head.bytes - tail.bytes);
    const marker = `\n\n[truncated ${omitted} bytes; preserved beginning and end]\n\n`;
    return `${head.text}${marker}${tail.text}`;
  }
}

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
