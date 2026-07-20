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
    this.buffer = Buffer.alloc(0);
    this.baseOffset = 0;
    this.totalBytes = 0;
  }

  /** @param {unknown} chunk */
  append(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!input.length) return;
    this.totalBytes += input.length;
    let combined = this.buffer.length ? Buffer.concat([this.buffer, input]) : Buffer.from(input);
    if (combined.length > this.maximumBytes) {
      const dropped = combined.length - this.maximumBytes;
      combined = combined.subarray(dropped);
      this.baseOffset += dropped;
    }
    this.buffer = combined;
  }

  /** @param {unknown} requestedOffset @param {unknown} maximumBytes */
  read(requestedOffset, maximumBytes) {
    const requested = nonNegativeInteger(requestedOffset);
    const maximum = positiveInteger(maximumBytes);
    const clampedOffset = Math.min(requested, this.totalBytes);
    const effectiveOffset = Math.max(clampedOffset, this.baseOffset);
    const start = effectiveOffset - this.baseOffset;
    const slice = this.buffer.subarray(start, Math.min(this.buffer.length, start + maximum));
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
