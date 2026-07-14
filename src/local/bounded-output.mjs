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

    if (this.full) {
      const combined = Buffer.concat([this.full, bytes]);
      if (combined.length <= this.maximum) {
        this.full = combined;
        return;
      }
      this.full = null;
      this.head = combined.subarray(0, this.headLimit);
      this.tail = this.tailLimit ? combined.subarray(Math.max(this.headLimit, combined.length - this.tailLimit)) : Buffer.alloc(0);
      return;
    }

    if (this.head.length < this.headLimit) {
      const missing = this.headLimit - this.head.length;
      this.head = Buffer.concat([this.head, bytes.subarray(0, missing)]);
    }
    if (this.tailLimit) {
      const combinedTail = Buffer.concat([this.tail, bytes]);
      this.tail = combinedTail.subarray(Math.max(0, combinedTail.length - this.tailLimit));
    }
  }

  get truncatedBytes() {
    return Math.max(0, this.totalBytes - this.maximum);
  }

  text() {
    if (this.full) return this.full.toString("utf8");
    const marker = `\n\n[truncated ${this.truncatedBytes} bytes; preserved beginning and end]\n\n`;
    return `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`;
  }
}
