// @ts-check

import { createSnapshotBudget, processGroupMembers } from "./process-tree-snapshot.mjs";
export { DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS } from "./process-tree-snapshot.mjs";
/** @typedef {import("./process-tree-ownership-types.d.ts").ChildProcessIdentity} ChildProcessIdentity */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipMember} ProcessOwnershipMember */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipSnapshot} ProcessOwnershipSnapshot */
/** @typedef {import("./process-tree-ownership-types.d.ts").ProcessOwnershipOptions} ProcessOwnershipOptions */

export async function captureProcessTreeOwnership(/** @type {ChildProcessIdentity} */ child, /** @type {ProcessOwnershipOptions} */ options = {}) {
  const pid = positivePid(child?.pid);
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
function positivePid(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : 0; }
/** @param {ChildProcessIdentity} child */
function childHasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}
