// @ts-check

/**
 * Convert filesystem identity fields without allowing IEEE-754 rounding to make distinct
 * platform identifiers compare equal. BigInt observations are preferred; injected Number
 * observations remain supported only when exactly representable.
 * @param {unknown} info
 * @param {string} [label]
 */
export function filesystemIdentity(info, label = "filesystem entry") {
  if (!info || typeof info !== "object") throw new Error(`${label} identity is unavailable`);
  const record = /** @type {Record<string, unknown>} */ (info);
  return Object.freeze({
    dev: exactFilesystemInteger(record.dev, `${label} device`),
    ino: exactFilesystemInteger(record.ino, `${label} inode`),
  });
}

/** @param {{dev: bigint, ino: bigint}} left @param {{dev: bigint, ino: bigint}} right */
export function sameFilesystemIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

/** @param {unknown} value @param {string} label */
export function exactFilesystemInteger(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} is invalid`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${label} cannot be represented losslessly`);
}

/** @param {unknown} value @param {string} label */
export function filesystemTimeMs(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} cannot be represented safely`);
    return Number(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${label} is invalid`);
}
