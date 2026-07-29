// @ts-check

import { spawnSync } from "node:child_process";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";

const PROCESS_SNAPSHOT_TIMEOUT_MS = 3000;
/** @typedef {import("./process-tree-ownership-types.d.ts").ChildProcessIdentity} ChildProcessIdentity */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessGroupEntry} ProcessGroupEntry */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipMember} ProcessOwnershipMember */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipSnapshot} ProcessOwnershipSnapshot */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipOptions} ProcessOwnershipOptions */

export function captureProcessTreeOwnership(/** @type {ChildProcessIdentity} */ child, /** @type {ProcessOwnershipOptions} */ options = {}) {
  const pid = positivePid(child?.pid);
  const platform = String(options.platform || process.platform);
  if (!pid) return { platform, pid: 0, members: [] };
  if (platform === "win32") return { platform, pid, members: [{ pid, startedAt: null }] };
  return { platform, pid, members: processGroupMembers(pid, options) };
}

export function refreshProcessTreeOwnership(/** @type {ProcessOwnershipSnapshot | null | undefined} */ snapshot, /** @type {ProcessOwnershipOptions} */ options = {}) {
  if (!snapshot?.pid || snapshot.platform === "win32") return snapshot;
  const members = [...(snapshot.members || [])];
  for (const observed of processGroupMembers(snapshot.pid, options)) {
    if (!members.some((expected) => sameProcessIdentity(expected, observed))) members.push(observed);
  }
  return { ...snapshot, members };
}

export function processTreeOwnershipStillCurrent(/** @type {ProcessOwnershipSnapshot | null | undefined} */ snapshot, /** @type {ChildProcessIdentity} */ child, /** @type {ProcessOwnershipOptions} */ options = {}) {
  if (!snapshot?.pid) return false;
  if (snapshot.platform === "win32") return !childHasExited(child);
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  if (members.length === 0) return false;
  const budget = createSnapshotBudget(options);
  const fullSnapshotTimeoutMs = budget.take(members.length + 1);
  if (!fullSnapshotTimeoutMs) return false;
  const current = processGroupMembers(snapshot.pid, options, 0, fullSnapshotTimeoutMs);
  if (members.some((expected) => current.some((observed) => sameProcessIdentity(expected, observed)))) return true;
  for (let index = 0; index < members.length; index += 1) {
    const timeoutMs = budget.take(members.length - index);
    if (!timeoutMs) return false;
    const expected = members[index];
    if (processGroupMembers(snapshot.pid, options, expected.pid, timeoutMs).some((observed) => sameProcessIdentity(expected, observed))) return true;
  }
  return false;
}

function processGroupMembers(/** @type {number} */ groupId, /** @type {ProcessOwnershipOptions} */ options = {}, /** @type {number} */ pid = 0, /** @type {number} */ timeoutMs = snapshotTimeout(options)) {
  const entries = typeof options.listProcessGroups === "function"
    ? options.listProcessGroups(options, pid, timeoutMs) : listProcessGroups(options, pid, timeoutMs, groupId);
  return entries.filter((entry) => entry.pgid === groupId).map(({ pid: memberPid, startedAt }) => ({ pid: memberPid, startedAt }));
}

function listProcessGroups(/** @type {ProcessOwnershipOptions} */ options = {}, /** @type {number} */ pid = 0, /** @type {number} */ timeoutMs = snapshotTimeout(options), /** @type {number} */ groupId = 0) {
  const run = typeof options.spawnSyncProcess === "function" ? options.spawnSyncProcess : defaultSpawnSyncProcess;
  const platform = String(options.platform || process.platform);
  const args = pid ? ["-p", String(pid), "-o", "pid=,pgid=,lstart="]
    : platform === "darwin" ? ["-g", String(groupId), "-o", "pid=,pgid=,lstart="] : ["-axo", "pid=,pgid=,lstart="];
  const result = run("ps", args, {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 512 * 1024,
    windowsHide: true, env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result?.error || result?.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map(parseProcessRow).filter(isProcessGroupEntry);
}

function defaultSpawnSyncProcess(/** @type {string} */ command, /** @type {string[]} */ args, /** @type {Record<string, unknown>} */ options) {
  const result = spawnSync(command, args, /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */ (/** @type {unknown} */ (options)));
  return { error: result.error, status: result.status, stdout: result.stdout };
}
function createSnapshotBudget(/** @type {ProcessOwnershipOptions} */ options) { const total = boundedPositive(options.ownershipCheckBudgetMs, PROCESS_SNAPSHOT_TIMEOUT_MS); const deadline = createMonotonicDeadline(total, options.monotonicNow); let unallocated = total; return { take(/** @type {number} */ slots) { const remaining = Math.min(unallocated, Math.floor(deadline.remainingMs())); if (remaining < 1) return 0; const value = Math.max(1, Math.min(PROCESS_SNAPSHOT_TIMEOUT_MS, Math.floor(remaining / Math.max(1, slots)))); unallocated -= value; return value; } }; }
function snapshotTimeout(/** @type {ProcessOwnershipOptions} */ options) { return boundedPositive(options.processSnapshotTimeoutMs, PROCESS_SNAPSHOT_TIMEOUT_MS); }
function boundedPositive(/** @type {unknown} */ value, /** @type {number} */ fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 1 ? Math.min(PROCESS_SNAPSHOT_TIMEOUT_MS, Math.floor(parsed)) : fallback; }
function parseProcessRow(/** @type {unknown} */ line) { const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(String(line || "")); if (!match) return null; const pid = positivePid(match[1]); const pgid = positivePid(match[2]); const startedAt = Date.parse(match[3]); return pid && pgid && Number.isFinite(startedAt) ? { pid, pgid, startedAt } : null; }
function isProcessGroupEntry(/** @type {ProcessGroupEntry | null} */ value) { return value !== null; }
function sameProcessIdentity(/** @type {ProcessOwnershipMember} */ left, /** @type {ProcessOwnershipMember} */ right) { return left.pid === right.pid && typeof left.startedAt === "number" && Number.isFinite(left.startedAt) && typeof right.startedAt === "number" && Number.isFinite(right.startedAt) && left.startedAt === right.startedAt; }
function positivePid(/** @type {unknown} */ value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
function childHasExited(/** @type {ChildProcessIdentity} */ child) { return child?.exitCode !== null && child?.exitCode !== undefined || child?.signalCode !== null && child?.signalCode !== undefined; }
