import { spawnSync } from "node:child_process";

const PROCESS_SNAPSHOT_TIMEOUT_MS = 3000;
const PROCESS_SNAPSHOT_BYTES = 512 * 1024;
const START_TIME_TOLERANCE_MS = 1500;

export function captureProcessTreeOwnership(child, options = {}) {
  const pid = positivePid(child?.pid);
  const platform = String(options.platform || process.platform);
  if (!pid) return { platform, pid: 0, members: [] };
  if (platform === "win32") return { platform, pid, members: [{ pid, startedAt: null }] };
  return { platform, pid, members: processGroupMembers(pid, options) };
}

export function refreshProcessTreeOwnership(snapshot, options = {}) {
  if (!snapshot?.pid || snapshot.platform === "win32") return snapshot;
  const members = [...(snapshot.members || [])];
  for (const observed of processGroupMembers(snapshot.pid, options)) {
    if (!members.some((expected) => sameProcessIdentity(expected, observed))) members.push(observed);
  }
  return { ...snapshot, members };
}

export function processTreeOwnershipStillCurrent(snapshot, child, options = {}) {
  if (!snapshot?.pid) return false;
  if (snapshot.platform === "win32") return !childHasExited(child);
  if (!Array.isArray(snapshot.members) || snapshot.members.length === 0) return !childHasExited(child);
  const current = processGroupMembers(snapshot.pid, options);
  if (snapshot.members.some((expected) => current.some((observed) => sameProcessIdentity(expected, observed)))) return true;
  return snapshot.members.some((expected) => processGroupMembers(snapshot.pid, options, expected.pid)
    .some((observed) => sameProcessIdentity(expected, observed)));
}

function processGroupMembers(groupId, options = {}, pid = 0) {
  const list = typeof options.listProcessGroups === "function" ? options.listProcessGroups : listProcessGroups;
  return list(options, pid).filter((entry) => entry.pgid === groupId).map(({ pid: memberPid, startedAt }) => ({ pid: memberPid, startedAt }));
}

function listProcessGroups(options = {}, pid = 0) {
  const run = typeof options.spawnSyncProcess === "function" ? options.spawnSyncProcess : spawnSync;
  const args = pid ? ["-p", String(pid), "-o", "pid=,pgid=,lstart="] : ["-axo", "pid=,pgid=,lstart="];
  const result = run("ps", args, {
    encoding: "utf8",
    timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
    maxBuffer: PROCESS_SNAPSHOT_BYTES,
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result?.error || result?.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map(parseProcessRow).filter(Boolean);
}

function parseProcessRow(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(String(line || ""));
  if (!match) return null;
  const pid = positivePid(match[1]);
  const pgid = positivePid(match[2]);
  const startedAt = Date.parse(match[3]);
  return pid && pgid && Number.isFinite(startedAt) ? { pid, pgid, startedAt } : null;
}

function sameProcessIdentity(left, right) {
  return left.pid === right.pid && Number.isFinite(left.startedAt) && Number.isFinite(right.startedAt)
    && Math.abs(left.startedAt - right.startedAt) <= START_TIME_TOLERANCE_MS;
}
function positivePid(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
function childHasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}
