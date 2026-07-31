// @ts-check

import { execFile } from "node:child_process";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

export const DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS = 3000;
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessGroupEntry} ProcessGroupEntry */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipOptions} ProcessOwnershipOptions */

/** @param {number} groupId @param {ProcessOwnershipOptions} [options] @param {number} [pid] @param {number} [timeoutMs] */
export async function processGroupMembers(groupId, options = {}, pid = 0, timeoutMs = snapshotTimeout(options)) {
  const entries = typeof options.listProcessGroups === "function"
    ? await options.listProcessGroups(options, pid, timeoutMs)
    : await listProcessGroups(options, pid, timeoutMs, groupId);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.pgid === groupId)
    .map(({ pid: memberPid, startedAt }) => ({ pid: memberPid, startedAt }));
}

/** @param {ProcessOwnershipOptions} [options] */
export function createSnapshotBudget(options = {}) {
  const total = boundedPositive(options.ownershipCheckBudgetMs, DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS);
  const deadline = createMonotonicDeadline(total, options.monotonicNow);
  let unallocated = total;
  return {
    /** @param {number} slots */
    take(slots) {
      const remaining = Math.min(unallocated, Math.floor(deadline.remainingMs()));
      if (remaining < 1) return 0;
      const value = Math.max(1, Math.min(DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS, Math.floor(remaining / Math.max(1, slots))));
      unallocated -= value;
      return value;
    },
  };
}

/** @param {ProcessOwnershipOptions} options @param {number} pid @param {number} timeoutMs @param {number} groupId */
async function listProcessGroups(options, pid, timeoutMs, groupId) {
  const run = typeof options.execFileProcess === "function" ? options.execFileProcess : defaultExecFileProcess;
  const platform = String(options.platform || process.platform);
  const args = pid ? ["-p", String(pid), "-o", "pid=,pgid=,lstart="]
    : platform === "darwin" ? ["-g", String(groupId), "-o", "pid=,pgid=,lstart="] : ["-axo", "pid=,pgid=,lstart="];
  const result = await run("ps", args, {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 512 * 1024,
    windowsHide: true, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
  });
  if (result?.error || result?.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map(parseProcessRow).filter(isProcessGroupEntry);
}

/** @param {string} command @param {string[]} args @param {Record<string, any>} options */
function defaultExecFileProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    execFile(command, args, options, (error, stdout) => resolvePromise({ error, status: error ? 1 : 0, stdout }));
  });
}
/** @param {ProcessOwnershipOptions} options */
function snapshotTimeout(options) {
  return boundedPositive(options.processSnapshotTimeoutMs, DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS);
}
/** @param {unknown} value @param {number} fallback */
function boundedPositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS, Math.floor(parsed)) : fallback;
}
/** @param {unknown} line */
function parseProcessRow(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(String(line || ""));
  if (!match) return null;
  const pid = positivePid(match[1]);
  const pgid = positivePid(match[2]);
  const startedAt = Date.parse(match[3]);
  return pid && pgid && Number.isFinite(startedAt) ? { pid, pgid, startedAt } : null;
}
function isProcessGroupEntry(/** @type {ProcessGroupEntry | null} */ value) { return value !== null; }
/** @param {unknown} value */
function positivePid(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
