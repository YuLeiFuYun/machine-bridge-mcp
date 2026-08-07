// @ts-check

import { isAbsolute, resolve } from "node:path";

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
      const { promise: gate, resolve: release } = Promise.withResolvers();
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
