// @ts-check
import { existsSync } from "node:fs";
import path from "node:path";

const GIB = 1024 ** 3;

/**
 * @param {number|string} totalBytes
 * @returns {number}
 */
export function resourceDiskHardFloorBytes(totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(50 * GIB, Math.max(5 * GIB, total * 0.10));
}

/**
 * @param {number|string} totalBytes
 * @returns {number}
 */
export function resourceDiskSoftFloorBytes(totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(80 * GIB, Math.max(8 * GIB, total * 0.15));
}
/** @param {any} request @param {any} pressure @param {number} maximumJobs @param {any} floorValue @returns {number} */
export function elasticMemoryJobLimit(request, pressure, maximumJobs, floorValue) {
  if (floorValue === null || floorValue === undefined || floorValue === "") return maximumJobs;
  const floor = Number(floorValue); const limit = Number(pressure?.limits?.memory_mb);
  const overcommit = Number(pressure?.limits?.memory_overcommit); const used = Number(pressure?.used?.memory_mb);
  if (![floor, limit, overcommit, used].every(Number.isFinite)) return maximumJobs;
  const incremental = Number(pressure?.requested?.memory_mb);
  const covered = Number.isFinite(incremental) ? Math.max(0, Number(request.memory_mb) - incremental) : 0;
  const available = Math.max(0, limit * overcommit + 1 - Math.max(0, used) + covered);
  for (let jobs = maximumJobs; jobs >= 1; jobs -= 1) {
    if (elasticMemoryMb(request, jobs, floor) <= available) return jobs;
  }
  return 1;
}

/** @param {any} request @param {number} jobs @param {any} floorValue */
export function elasticMemoryMb(request, jobs, floorValue) {
  const floor = Number(floorValue);
  if (!Number.isFinite(floor)) return request.memory_mb;
  return Math.min(request.memory_mb, Math.max(floor, Math.ceil(request.memory_mb * jobs / request.compiler_jobs)));
}
const POSIX_NICE = "/usr/bin/nice";

const BACKGROUND_NICE_INCREMENT = 5;

const UNBOUNDED_NICE_INCREMENT = 2;

/**
 * @param {string} command
 * @param {readonly unknown[]} args
 * @param {{ heavy?: boolean, priority?: string, unbounded?: boolean }} [request]
 * @param {{ niceExecutable?: string }} [options]
 * @returns {{ command: string, args: string[] }}
 */
export function applyResourceProcessPriority(command, args, request, options = {}) {
  const values = args.map(String);
  if (process.platform === "win32" || request?.heavy !== true) return { command, args: values };
  const increment = request?.priority === "background" ? BACKGROUND_NICE_INCREMENT : request?.unbounded === true ? UNBOUNDED_NICE_INCREMENT : 0;
  if (!increment) return { command, args: values };
  const nice = String(options.niceExecutable || POSIX_NICE);
  if (!existsSync(nice)) return { command, args: values };
  return { command: nice, args: ["-n", String(increment), String(command), ...values] };
}
const NODE_TARGET_NAMES = new Set(["node", "node.exe"]);

const CANARY_ENTRY_NAME = "release-oauth-canary.mjs";

const CANARY_FLAG = "--allow-live-oauth-canary";

/** @param {unknown} base @param {readonly unknown[]} [args] @returns {boolean} */
export function releaseControlCommandIsLight(base, args = []) {
  const head = String(base || "").toLowerCase();
  if (!NODE_TARGET_NAMES.has(head)) return false;
  const values = args.map((value) => String(value));
  if (values.length !== 2 || values[1] !== CANARY_FLAG) return false;
  const entry = values[0];
  return path.isAbsolute(entry) && path.basename(entry).toLowerCase() === CANARY_ENTRY_NAME;
}
const FAMILY = /^[a-z][a-z0-9-]{0,47}$/;

const CONTENTION_KEY = /^[a-f0-9]{32}$/;

const RESOURCE_CLASSES = new Set(["adaptive", "cpu", "io", "mixed", "unbounded"]);

const PRIORITIES = new Set(["interactive", "ordinary", "background"]);

export const RESOURCE_REQUEST_KEYS = Object.freeze([
  "family", "resource_class", "priority", "cpu", "io", "memory_mb",
  "disk_reserve_bytes", "heavy", "compiler_jobs", "unbounded", "serialize_project", "contention_key",
]);

/**
 * @param {Record<string, unknown> | null | undefined} [request]
 * @returns {Record<string, unknown>}
 */
export function normalizeResourceRequest(request = {}) {
  const source = request && typeof request === "object" ? request : {};
  return Object.fromEntries(RESOURCE_REQUEST_KEYS.map((key) => [key, source[key] ?? null]));
}

/**
 * @param {Record<string, unknown>} request
 * @returns {Record<string, unknown>}
 */
export function validateResourceRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("resource request is invalid");
  if (typeof request.family !== "string" || !FAMILY.test(request.family) || !RESOURCE_CLASSES.has(/** @type {string} */ (request.resource_class))
      || !PRIORITIES.has(/** @type {string} */ (request.priority)) || request.heavy !== true
      || typeof request.unbounded !== "boolean" || typeof request.serialize_project !== "boolean") {
    throw new Error("resource request contract is invalid");
  }
  finiteRange(request.cpu, 0, 1024, "cpu");
  finiteRange(request.io, 0, 1024, "io");
  finiteRange(request.memory_mb, 0, 16 * 1024 * 1024, "memory");
  finiteRange(request.disk_reserve_bytes, 0, 1024 ** 5, "disk reservation");
  if (request.compiler_jobs !== null && (!Number.isInteger(request.compiler_jobs) || /** @type {number} */ (request.compiler_jobs) < 1 || /** @type {number} */ (request.compiler_jobs) > 1024)) {
    throw new Error("resource request compiler jobs are invalid");
  }
  if (request.contention_key !== null
      && (typeof request.contention_key !== "string" || !CONTENTION_KEY.test(request.contention_key))) {
    throw new Error("resource request contention key is invalid");
  }
  return request;
}

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @param {string} label
 */
function finiteRange(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`resource request ${label} is invalid`);
  }
}
