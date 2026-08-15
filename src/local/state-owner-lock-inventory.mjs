import { resolve } from "node:path";
import { readOwnerStateLock } from "./owner-state-lock.mjs";
import { inspectProcessInstance } from "./process-identity.mjs";
import { inspectPathIfPresentSync } from "./secure-file.mjs";

export function activeOwnerStateLocks(stateRoot) {
  const toolchains = resolve(stateRoot, "toolchains");
  const directory = inspectPathIfPresentSync(toolchains, "toolchain state");
  if (!directory) return [];
  if (directory.isSymbolicLink() || !directory.isDirectory()) return [blocker("toolchain-state", null, "invalid_or_unreadable_state")];
  const lockPath = resolve(toolchains, "wrangler-toolchain.lock");
  if (!inspectPathIfPresentSync(lockPath, "Wrangler toolchain lock")) return [];
  let inspected;
  try { inspected = readOwnerStateLock(lockPath, "wrangler-toolchain"); }
  catch { return [blocker("toolchain", null, "invalid_or_unreadable_lock")]; }
  if (inspected.kind === "missing") return [];
  if (inspected.kind !== "owner") return [blocker("toolchain", null, "invalid_or_unreadable_lock")];
  const identity = inspectProcessInstance(inspected.owner);
  if (!identity.current && !(identity.alive && !identity.reclaimable)) return [];
  return [blocker("toolchain", inspected.owner.pid, identity.reason)];
}

function blocker(kind, pid, reason) { return { kind, pid: Number.isInteger(pid) ? pid : null, reason }; }
