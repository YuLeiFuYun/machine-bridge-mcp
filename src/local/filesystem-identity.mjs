// @ts-check

/**
 * Convert filesystem identity fields without allowing IEEE-754 rounding to make distinct
 * platform identifiers compare equal. BigInt observations are preferred; injected Number
 * observations remain supported only when exactly representable. When the platform
 * exposes a change-time generation, retain it so immediate inode reuse cannot create an
 * ABA-equivalent identity during destructive snapshot checks.
 * @param {unknown} info
 * @param {string} [label]
 */
export function filesystemIdentity(info, label = "filesystem entry") {
  if (!info || typeof info !== "object") throw new Error(`${label} identity is unavailable`);
  const record = /** @type {Record<string, unknown>} */ (info);
  const generation = filesystemGeneration(record, label);
  return Object.freeze({
    dev: exactFilesystemInteger(record.dev, `${label} device`),
    ino: exactFilesystemInteger(record.ino, `${label} inode`),
    ...generation,
  });
}
/** @param {{dev: bigint, ino: bigint, ctimeNs?: bigint, ctimeMs?: number} | null | undefined} left @param {{dev: bigint, ino: bigint, ctimeNs?: bigint, ctimeMs?: number} | null | undefined} right */
export function sameFilesystemIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.ctimeNs !== undefined || right.ctimeNs !== undefined) return left.ctimeNs !== undefined && left.ctimeNs === right.ctimeNs;
  if (left.ctimeMs !== undefined || right.ctimeMs !== undefined) return left.ctimeMs !== undefined && left.ctimeMs === right.ctimeMs;
  return true;
}
/** @param {Record<string, unknown>} record @param {string} label */
function filesystemGeneration(record, label) {
  if (record.ctimeNs !== undefined) return { ctimeNs: exactFilesystemInteger(record.ctimeNs, `${label} change time`) };
  if (record.ctimeMs !== undefined) return { ctimeMs: filesystemTimeMs(record.ctimeMs, `${label} change time`) };
  return {};
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
