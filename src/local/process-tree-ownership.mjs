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

export function processTreeOwnershipStillCurrent(snapshot, child, options = {}) {
  if (!snapshot?.pid) return false;
  if (snapshot.platform === "win32") return !childHasExited(child);
  if (!Array.isArray(snapshot.members) || snapshot.members.length === 0) return !childHasExited(child);
  const current = processGroupMembers(snapshot.pid, options);
  return snapshot.members.some((expected) => current.some((observed) => sameProcessIdentity(expected, observed)));
}

function processGroupMembers(groupId, options = {}) {
  const list = typeof options.listProcessGroups === "function" ? options.listProcessGroups : listProcessGroups;
  return list(options).filter((entry) => entry.pgid === groupId).map(({ pid, startedAt }) => ({ pid, startedAt }));
}

function listProcessGroups(options = {}) {
  const run = typeof options.spawnSyncProcess === "function" ? options.spawnSyncProcess : spawnSync;
  const result = run("ps", ["-axo", "pid=,pgid=,lstart="], {
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
