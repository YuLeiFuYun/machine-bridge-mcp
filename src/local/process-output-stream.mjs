// @ts-check

/**
 * Bounded byte stream shared by interactive process sessions and completed
 * one-shot command continuations. It retains the newest bytes while keeping
 * monotonic offsets so callers can detect data that aged out of the buffer.
 */
export class ProcessOutputStream {
  /** @param {number} maximumBytes */
  constructor(maximumBytes) {
    const maximum = Number(maximumBytes);
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("maximum retained output bytes must be a positive safe integer");
    }
    this.maximumBytes = maximum;
    this.storage = Buffer.alloc(maximum);
    this.writeOffset = 0;
    this.retainedBytes = 0;
    this.baseOffset = 0;
    this.totalBytes = 0;
  }

  get buffer() {
    const start = (this.writeOffset - this.retainedBytes + this.maximumBytes) % this.maximumBytes;
    const end = start + this.retainedBytes;
    if (end <= this.maximumBytes) return Buffer.from(this.storage.subarray(start, end));
    return Buffer.concat([
      this.storage.subarray(start),
      this.storage.subarray(0, end - this.maximumBytes),
    ], this.retainedBytes);
  }

  /** @param {unknown} chunk */
  append(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!input.length) return;
    this.totalBytes += input.length;
    if (input.length >= this.maximumBytes) {
      this.storage.set(input.subarray(input.length - this.maximumBytes));
      this.writeOffset = 0;
      this.retainedBytes = this.maximumBytes;
      this.baseOffset = this.totalBytes - this.retainedBytes;
      return;
    }
    const first = Math.min(input.length, this.maximumBytes - this.writeOffset);
    this.storage.set(input.subarray(0, first), this.writeOffset);
    if (first < input.length) this.storage.set(input.subarray(first), 0);
    this.writeOffset = (this.writeOffset + input.length) % this.maximumBytes;
    this.retainedBytes = Math.min(this.maximumBytes, this.retainedBytes + input.length);
    this.baseOffset = this.totalBytes - this.retainedBytes;
  }

  /** @param {unknown} requestedOffset @param {unknown} maximumBytes */
  read(requestedOffset, maximumBytes) {
    const requested = nonNegativeInteger(requestedOffset);
    const maximum = positiveInteger(maximumBytes);
    const clampedOffset = Math.min(requested, this.totalBytes);
    const effectiveOffset = Math.max(clampedOffset, this.baseOffset);
    const start = effectiveOffset - this.baseOffset;
    const length = Math.min(maximum, this.retainedBytes - start);
    const ringStart = (this.writeOffset - this.retainedBytes + start + this.maximumBytes) % this.maximumBytes;
    const ringEnd = ringStart + length;
    const slice = length <= 0 ? Buffer.alloc(0)
      : ringEnd <= this.maximumBytes ? this.storage.subarray(ringStart, ringEnd)
        : Buffer.concat([this.storage.subarray(ringStart), this.storage.subarray(0, ringEnd - this.maximumBytes)], length);
    const decoded = decodeProcessBytes(slice);
    return {
      ...decoded,
      requested_offset: requested,
      start_offset: effectiveOffset,
      next_offset: effectiveOffset + slice.length,
      total_offset: this.totalBytes,
      retained_start_offset: this.baseOffset,
      truncated_before: requested < this.baseOffset,
      truncated_after: effectiveOffset + slice.length < this.totalBytes,
    };
  }

}

/** @param {Buffer} bytes */
function decodeProcessBytes(bytes) {
  try {
    return { data: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return {
      data: new TextDecoder("utf-8").decode(bytes),
      data_base64: bytes.toString("base64"),
      encoding: "base64",
    };
  }
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return number;
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return 1;
  return number;
}
