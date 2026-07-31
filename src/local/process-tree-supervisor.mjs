import {
  captureProcessTreeOwnership,
  processTreeOwnershipStillCurrent,
  refreshProcessTreeOwnership,
} from "./process-tree-ownership.mjs";
import { terminateProcessTree } from "./process-tree-signal.mjs";

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

  let ownershipBeforeSignal;
  try { ownershipBeforeSignal = Promise.resolve(capture(child, options)).catch(() => null); }
  catch { ownershipBeforeSignal = Promise.resolve(null); }
  try { terminate(child, "SIGTERM", options); } catch {}
  const refreshedOwnership = ownershipBeforeSignal
    .then((snapshot) => snapshot ? refresh(snapshot, options) : null)
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
    try { options.onEscalated?.(); } catch {}
  } finally {
    try { options.onTerminationSettled?.(); } catch {}
  }
}
