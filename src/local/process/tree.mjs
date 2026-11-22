import { spawn } from "node:child_process";
import { captureProcessTreeOwnership, processTreeOwnershipStillCurrent, refreshProcessTreeOwnership, createSnapshotBudget } from "./tree-snapshot.mjs";

export function terminateProcessTree(child, signal = "SIGTERM", options = {}) {
  if (!child?.pid) return false;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    try {
      const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
      const force = signal === "SIGKILL";
      const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
      let fallbackUsed = false;
      const fallback = () => {
        if (fallbackUsed) return;
        fallbackUsed = true;
        try { child.kill(signal); }
        catch { /* Callers that require proof wait for process settlement instead of trusting this best-effort fallback. */ }
      };
      killer?.once?.("error", fallback);
      killer?.once?.("exit", (code) => { if (code !== 0) fallback(); });
      killer?.unref?.();
      return true;
    } catch {
      // Fall through to ChildProcess.kill for environments without taskkill.
    }
  }
  const killProcess = typeof options.killProcess === "function" ? options.killProcess : process.kill.bind(process);
  try { killProcess(-child.pid, signal); return true; }
  catch {
    try { return child.kill(signal) !== false; }
    catch { return false; }
  }
}
export const DEFAULT_FORCE_TREE_SETTLEMENT_MS = 5_000;

export function terminateProcessTreeAndWait(child, signal = "SIGKILL", options = {}) {
  if (!child?.pid) return Promise.resolve(false);
  if (String(options.platform || process.platform) !== "win32") {
    return Promise.resolve(terminateProcessTree(child, signal, options));
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearSchedule = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const waitMs = boundedWait(options.waitMs);
  return new Promise((resolvePromise) => {
    let killer; let timer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearSchedule(timer);
      resolvePromise(value === true);
    };
    const fallback = () => {
      try { child.kill(signal); } catch { /* Request failure is reported by the false settlement below. */ }
      finish(false);
    };
    try {
      killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
    } catch { fallback(); return; }
    killer.once?.("error", fallback);
    killer.once?.("close", (code) => { if (code === 0) finish(true); else fallback(); });
    timer = schedule(() => {
      try { killer.kill?.("SIGKILL"); } catch { /* The bounded false settlement remains authoritative. */ }
      fallback();
    }, waitMs);
  });
}

function boundedWait(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(30_000, Math.floor(parsed)) : DEFAULT_FORCE_TREE_SETTLEMENT_MS;
}
export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 2000;

export function terminateProcessTreeWithEscalation(child, options = {}) {
  const graceMs = Number.isFinite(Number(options.graceMs))
    ? Math.max(0, Number(options.graceMs))
    : DEFAULT_PROCESS_TERMINATION_GRACE_MS;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const terminate = typeof options.terminate === "function" ? options.terminate : terminateProcessTree;
  const capture = typeof options.captureOwnership === "function"
    ? options.captureOwnership : captureProcessTreeOwnership;
  const refresh = typeof options.refreshOwnership === "function"
    ? options.refreshOwnership : refreshProcessTreeOwnership;
  const isOwned = typeof options.isTerminationTargetOwned === "function"
    ? options.isTerminationTargetOwned : processTreeOwnershipStillCurrent;

  const snapshotBudget = createSnapshotBudget(options);
  let ownershipBeforeSignal;
  try {
    const captureOptions = boundedSnapshotOptions(snapshotBudget, options, 2);
    ownershipBeforeSignal = captureOptions
      ? Promise.resolve(capture(child, captureOptions)).catch(() => null)
      : Promise.resolve(null);
  } catch { ownershipBeforeSignal = Promise.resolve(null); }
  try { terminate(child, "SIGTERM", options); }
  catch { /* Ownership-checked forced escalation remains available after the grace period. */ }
  const refreshedOwnership = ownershipBeforeSignal
    .then((snapshot) => {
      if (!snapshot) return null;
      const refreshOptions = boundedSnapshotOptions(snapshotBudget, options, 1);
      return refreshOptions ? refresh(snapshot, refreshOptions) : null;
    })
    .catch(() => null);

  return schedule(() => superviseEscalation({
    child, options, terminate, isOwned, refreshedOwnership,
  }), graceMs);
}

async function superviseEscalation({ child, options, terminate, isOwned, refreshedOwnership }) {
  try {
    const ownership = await refreshedOwnership;
    if (!ownership) return;
    let owned = false;
    try { owned = await isOwned(ownership, child, options); } catch { return; }
    if (!owned) return;
    try { terminate(child, "SIGKILL", options); } catch { return; }
    try { options.onEscalated?.(); } catch { /* Observer failure must not suppress termination settlement. */ }
  } finally {
    try { options.onTerminationSettled?.(); } catch { /* Observer failure cannot change settled supervision. */ }
  }
}

function boundedSnapshotOptions(budget, options, slots) {
  const remainingMs = budget.take(slots);
  if (!remainingMs) return null;
  const configuredMs = Number(options.processSnapshotTimeoutMs);
  const processSnapshotTimeoutMs = Number.isFinite(configuredMs) && configuredMs >= 1
    ? Math.min(remainingMs, Math.floor(configuredMs))
    : remainingMs;
  return { ...options, processSnapshotTimeoutMs };
}
