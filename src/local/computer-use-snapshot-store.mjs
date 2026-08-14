// @ts-check
import { performance } from "node:perf_hooks";
import { BridgeError } from "./errors.mjs";
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 64;
/** @typedef {{ createdAt: number, observation: Record<string, any>, privateState: any }} SnapshotItem */
export class ComputerUseSnapshotStore {
  /** @param {{ now?: () => number, createId: () => string }} options */
  constructor({ now = () => performance.now(), createId }) {
    if (typeof createId !== "function") throw new TypeError("computer snapshot store requires an id factory");
    this.now = now;
    this.createId = createId;
    /** @type {Map<string, SnapshotItem>} */
    this.items = new Map();
    /** @type {number | null} */
    this.lastNow = null;
  }
  /** @param {Record<string, any>} observation @param {any} [privateState] */
  add(observation, privateState = null) {
    this.prune();
    while (this.items.size >= MAX_SNAPSHOTS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    let id = this.createId();
    while (this.items.has(id)) id = this.createId();
    this.items.set(id, { createdAt: this.readNow(), observation, privateState });
    return id;
  }
  /** @param {string} id */
  get(id) {
    this.prune();
    const item = this.items.get(id);
    if (!item) throw missingSnapshot("computer snapshot is missing or expired; observe again before acting");
    this.items.delete(id);
    this.items.set(id, item);
    return item;
  }
  /** @param {string} id @param {SnapshotItem} expected */
  claim(id, expected) {
    this.prune();
    const item = this.items.get(id);
    if (!item || item !== expected) throw missingSnapshot("computer snapshot is missing, expired, or already consumed; observe again before acting");
    this.items.delete(id);
    return item;
  }
  /** @param {string} id */
  discard(id) {
    if (id) this.items.delete(id);
  }
  prune() {
    const cutoff = this.readNow() - SNAPSHOT_TTL_MS;
    for (const [id, item] of this.items) if (item.createdAt < cutoff) this.items.delete(id);
  }
  /** @returns {number} */
  readNow() {
    const value = Number(this.now());
    if (!Number.isFinite(value)) throw new TypeError("computer snapshot monotonic clock returned a non-finite value");
    if (this.lastNow === null || value > this.lastNow) this.lastNow = value;
    return /** @type {number} */ (this.lastNow);
  }
}
/** @param {string} message */
function missingSnapshot(message) {
  return new BridgeError("conflict", message, { details: { reason: "snapshot_missing_or_expired" } });
}
