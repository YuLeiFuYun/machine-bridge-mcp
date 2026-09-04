import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { removeOwnedJsonFileSync } from "./exclusive-file.mjs";
import { inspectProcessInstance, isPidAlive, processStartTimeMs, processState } from "./process-identity.mjs";
import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { atomicWriteJson, readJson } from "./managed-job-storage.mjs";

const ACTIVE_CHILD_SCHEMA = 1;
const MAX_ACTIVE_CHILD_BYTES = 8192;

export function managedJobActiveChildFile(jobDir) {
  return join(jobDir, "active-child.json");
}

export function publishManagedJobActiveChild(file, child, options = {}) {
  const pid = positivePid(child?.pid);
  if (!pid) throw new Error("managed job child process did not receive a valid pid");
  const observedStart = (options.processStartTime || processStartTimeMs)(pid);
  const processIdentityVerified = Number.isFinite(observedStart) && observedStart > 0;
  if (!processIdentityVerified && (childExited(child) || !(options.isAlive || isPidAlive)(pid)
      || (options.processState || processState)(pid) === "zombie")) return null;
  const existing = readActiveChildClaim(file, options);
  if (existing) {
    if (activeChildState(existing, options) !== "stopped") throw new Error("managed job active child claim already exists");
    clearManagedJobActiveChild(file, existing, options);
  }
  const claim = {
    schema_version: ACTIVE_CHILD_SCHEMA,
    pid,
    token: (options.randomBytes || randomBytes)(16).toString("hex"),
    startedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    processStartedAt: new Date(processIdentityVerified ? observedStart : (options.now?.() ?? Date.now())).toISOString(),
    processIdentityVerified,
    processGroupIsolated: (options.platform || process.platform) !== "win32",
  };
  (options.writeJson || atomicWriteJson)(file, claim, MAX_ACTIVE_CHILD_BYTES);
  return claim;
}

export function clearManagedJobActiveChild(file, claim, options = {}) {
  if (!claim) return true;
  const remove = options.removeOwned || removeOwnedJsonFileSync;
  if (remove(file, { pid: claim.pid, token: claim.token }, { maxBytes: MAX_ACTIVE_CHILD_BYTES })) return true;
  const current = readActiveChildClaim(file, options);
  if (!current) return true;
  if (current.pid === claim.pid && current.token === claim.token) {
    throw new Error("managed job active child claim could not be removed safely");
  }
  throw new Error("managed job active child claim changed before cleanup");
}

export function managedJobActiveChildRecoveryReady(file, options = {}) {
  return managedJobActiveChildRecoveryState(file, options) === "ready";
}

export function managedJobActiveChildRecoveryState(file, options = {}) {
  let claim;
  try { claim = readActiveChildClaim(file, options); }
  catch { return "ambiguous"; }
  if (!claim) return "ready";
  const state = activeChildState(claim, options);
  if (state !== "stopped") return state;
  try { clearManagedJobActiveChild(file, claim, options); }
  catch { return "ambiguous"; }
  return "ready";
}

export async function terminateManagedJobActiveChild(file, options = {}) {
  const claim = readActiveChildClaim(file, options);
  if (!claim) return { active_child_present: false, terminated: false };
  const initialState = activeChildState(claim, options);
  if (initialState === "stopped") {
    clearManagedJobActiveChild(file, claim, options);
    return { active_child_present: true, terminated: false };
  }
  if (initialState !== "current") throw new Error("managed job active child ownership cannot be verified");

  const child = recoveredChild(claim, options);
  const terminateWithEscalation = options.terminateWithEscalation || terminateProcessTreeWithEscalation;
  const terminate = options.terminate || terminateProcessTree;
  await new Promise((resolvePromise, rejectPromise) => {
    try {
      terminateWithEscalation(child, {
        ...(options.terminationOptions || {}),
        terminate(target, signal, terminationOptions) {
          const currentState = activeChildState(claim, options);
          if (currentState === "stopped") return false;
          if (currentState !== "current") throw new Error("managed job active child ownership changed before termination");
          return terminate(target, signal, terminationOptions);
        },
        onTerminationSettled: resolvePromise,
      });
    } catch (error) { rejectPromise(error); }
  });
  const settledState = activeChildState(claim, options);
  if (settledState !== "stopped") throw new Error("managed job active child did not settle after process-tree termination");
  clearManagedJobActiveChild(file, claim, options);
  return { active_child_present: true, terminated: true };
}

function readActiveChildClaim(file, options) {
  const value = readJson(file, MAX_ACTIVE_CHILD_BYTES, "managed job active child", options.readOptions || {});
  if (!value) return null;
  const platform = String(options.platform || process.platform);
  if (value.schema_version !== ACTIVE_CHILD_SCHEMA || !positivePid(value.pid)
      || !/^[a-f0-9]{32}$/.test(String(value.token || ""))
      || !validTime(value.startedAt) || !validTime(value.processStartedAt)
      || (value.processIdentityVerified !== undefined && typeof value.processIdentityVerified !== "boolean")
      || typeof value.processGroupIsolated !== "boolean"
      || value.processGroupIsolated !== (platform !== "win32")) {
    throw new Error("managed job active child claim is invalid");
  }
  return value;
}

function activeChildState(claim, options) {
  const inspect = options.inspectProcess || inspectProcessInstance;
  const state = (options.processState || processState)(claim.pid);
  if (state === "zombie") return "stopped";
  const observed = inspect(claim, options.inspectOptions || {});
  if (observed?.alive === false || observed?.reason === "pid_reused") return "stopped";
  if (claim.processIdentityVerified === false) return "ambiguous";
  if (observed?.current === true && observed?.alive === true) return "current";
  return "ambiguous";
}

function recoveredChild(claim, options) {
  const killProcess = options.killProcess || process.kill.bind(process);
  return {
    pid: claim.pid,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      try { killProcess(claim.pid, signal); return true; }
      catch { return false; }
    },
  };
}

function childExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function validTime(value) {
  return Number.isFinite(Date.parse(String(value || "")));
}
