// @ts-check
import { lstat, opendir } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

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
/**
 * @param {any} error
 * @returns {boolean}
 */
export function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

/**
 * @param {string} path
 * @param {(p: string) => Promise<any>} [inspect]
 * @returns {Promise<any>}
 */
export async function pathEntryIfExists(path, inspect = lstat) {
  try {
    return await inspect(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/**
 * @param {string} path
 * @param {(p: string) => Promise<any>} [openDirectory]
 * @returns {Promise<any>}
 */
export async function openDirectoryIfExists(path, openDirectory = opendir) {
  try {
    return await openDirectory(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}
export const DIRECTORY_METADATA_BATCH_SIZE = 16;

/** @typedef {{openDirectory?: (directory: string) => Promise<import('node:fs').Dir>, inspect?: (path: string) => Promise<import('node:fs').Stats | null>, throwIfCancelled?: (context: unknown) => void, context?: unknown, batchSize?: number}} DirectoryMetadataOptions */
/** @param {string} directory @param {DirectoryMetadataOptions} [options] */
export async function* directoryEntriesWithMetadata(directory, options = {}) {
  const openDirectory = options.openDirectory || opendir;
  const inspect = options.inspect || pathEntryIfExists;
  const throwIfCancelled = typeof options.throwIfCancelled === "function" ? options.throwIfCancelled : () => {};
  const context = options.context ?? {};
  const batchSize = positiveBatchSize(options.batchSize);
  const handle = await openDirectory(directory);
  /** @type {{entry: import('node:fs').Dirent, path: string}[]} */
  let batch = [];
  for await (const entry of handle) {
    throwIfCancelled(context);
    batch.push({ entry, path: resolve(directory, entry.name) });
    if (batch.length < batchSize) continue;
    const settled = await inspectBatch(batch, inspect, throwIfCancelled, context);
    batch = [];
    for (const result of settled) {
      throwIfCancelled(context);
      if (result.status === "rejected") throw result.reason;
      yield result.value;
    }
  }
  if (!batch.length) return;
  const settled = await inspectBatch(batch, inspect, throwIfCancelled, context);
  for (const result of settled) {
    throwIfCancelled(context);
    if (result.status === "rejected") throw result.reason;
    yield result.value;
  }
}

/** @param {{entry: import('node:fs').Dirent, path: string}[]} batch @param {(path: string) => Promise<import('node:fs').Stats | null>} inspect @param {(context: unknown) => void} throwIfCancelled @param {unknown} context */
async function inspectBatch(batch, inspect, throwIfCancelled, context) {
  return Promise.allSettled(batch.map(async (item) => {
    throwIfCancelled(context);
    return { ...item, info: await inspect(item.path) };
  }));
}

/** @param {unknown} value @returns {number} */
function positiveBatchSize(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 64 ? value : DIRECTORY_METADATA_BATCH_SIZE;
}
/**
 * Process-local coordinator for filesystem mutations that already resolved their target paths.
 * Reservations are registered for every path before waiting, so overlapping multi-path mutations
 * cannot deadlock while unrelated paths remain concurrent.
 */
export class FileMutationCoordinator {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.queues = new Map();
  }

  /** @template T @param {string[]} paths @param {() => Promise<T>} callback @returns {Promise<T>} */
  async withPaths(paths, callback) {
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError("file mutation requires at least one resolved path");
    if (typeof callback !== "function") throw new TypeError("file mutation callback is required");
    const keys = [...new Set(paths.map((value) => fileMutationPathKey(value)))].sort();
    const reservations = keys.map((key) => {
      const current = this.queues.get(key) ?? Promise.resolve();
      /** @type {{release?: () => void}} */
      const gateState = {};
      /** @type {Promise<void>} */
      const gate = new Promise((resolve) => { gateState.release = () => resolve(undefined); });
      const release = gateState.release;
      if (typeof release !== "function") throw new Error("file mutation gate failed to initialize");
      const tail = current.then(() => gate);
      this.queues.set(key, tail);
      return { key, current, tail, release };
    });

    await Promise.all(reservations.map((reservation) => reservation.current));
    try {
      return await callback();
    } finally {
      for (const reservation of reservations) reservation.release();
      for (const reservation of reservations) {
        if (this.queues.get(reservation.key) === reservation.tail) this.queues.delete(reservation.key);
      }
    }
  }
}

/** @param {unknown} value @param {string} [platform] */
export function fileMutationPathKey(value, platform = process.platform) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !isAbsolute(raw)) throw new TypeError("file mutation paths must be absolute and NUL-free");
  const absolute = resolve(raw);
  return platform === "win32" || platform === "darwin" ? absolute.toLowerCase() : absolute;
}
