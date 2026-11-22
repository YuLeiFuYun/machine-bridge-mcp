// @ts-check
import { execFile } from "node:child_process";
import { createMonotonicDeadline } from "../core/timing.mjs";

export const DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS = 3000;

/** @typedef {import("./tree-ownership-types.d.ts").ProcessGroupEntry} ProcessGroupEntry */
/** @typedef {import("./tree-ownership-types.d.ts").ProcessOwnershipOptions} ProcessOwnershipOptions */

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
/** @typedef {import("./tree-ownership-types.d.ts").ChildProcessIdentity} ChildProcessIdentity */
/** @typedef {import("./tree-ownership-types.d.ts").ProcessOwnershipMember} ProcessOwnershipMember */
/** @typedef {import("./tree-ownership-types.d.ts").ProcessOwnershipSnapshot} ProcessOwnershipSnapshot */

export async function captureProcessTreeOwnership(/** @type {ChildProcessIdentity} */ child, /** @type {ProcessOwnershipOptions} */ options = {}) {
  const pid = ownershipPositivePid(child?.pid);
  const platform = String(options.platform || process.platform);
  if (!pid) return { platform, pid: 0, members: [] };
  if (platform === "win32") return { platform, pid, members: [{ pid, startedAt: null }] };
  return { platform, pid, members: await processGroupMembers(pid, options) };
}

export async function refreshProcessTreeOwnership(/** @type {ProcessOwnershipSnapshot | null | undefined} */ snapshot, /** @type {ProcessOwnershipOptions} */ options = {}) {
  if (!snapshot?.pid || snapshot.platform === "win32") return snapshot;
  const members = [...(snapshot.members || [])];
  for (const observed of await processGroupMembers(snapshot.pid, options)) {
    if (!members.some((expected) => sameProcessIdentity(expected, observed))) members.push(observed);
  }
  return { ...snapshot, members };
}

export async function processTreeOwnershipStillCurrent(/** @type {ProcessOwnershipSnapshot | null | undefined} */ snapshot, /** @type {ChildProcessIdentity} */ child, /** @type {ProcessOwnershipOptions} */ options = {}) {
  if (!snapshot?.pid) return false;
  if (snapshot.platform === "win32") return !childHasExited(child);
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  if (members.length === 0) return false;
  const budget = createSnapshotBudget(options);
  const fullTimeout = budget.take(members.length + 1);
  if (!fullTimeout) return false;
  const current = await processGroupMembers(snapshot.pid, options, 0, fullTimeout);
  if (members.some((expected) => current.some((observed) => sameProcessIdentity(expected, observed)))) return true;
  for (let index = 0; index < members.length; index += 1) {
    const timeoutMs = budget.take(members.length - index);
    if (!timeoutMs) return false;
    const expected = members[index];
    const targeted = await processGroupMembers(snapshot.pid, options, expected.pid, timeoutMs);
    if (targeted.some((observed) => sameProcessIdentity(expected, observed))) return true;
  }
  return false;
}

function sameProcessIdentity(/** @type {ProcessOwnershipMember} */ left, /** @type {ProcessOwnershipMember} */ right) {
  return left.pid === right.pid && Number.isFinite(left.startedAt) && Number.isFinite(right.startedAt)
    && left.startedAt === right.startedAt;
}

/** @param {unknown} value */
function ownershipPositivePid(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0; }

/** @param {ChildProcessIdentity} child */
function childHasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}
