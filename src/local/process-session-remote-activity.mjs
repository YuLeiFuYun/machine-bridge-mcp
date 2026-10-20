// @ts-check
/** @param {{ origin?: string }} [context] @param {{ beginActivity?: () => void, endActivity?: () => void } | null} [guard] */
export function beginRemoteProcessSessionActivity(context, guard) {
  if (context?.origin !== "relay" || !guard) return false;
  try { guard.beginActivity?.(); } catch { /* Auxiliary power management must not change session startup. */ }
  return true;
}

/** @param {boolean} held @param {{ beginActivity?: () => void, endActivity?: () => void } | null} [guard] */
export function endRemoteProcessSessionActivity(held, guard) {
  if (!held || !guard) return;
  try { guard.endActivity?.(); } catch { /* Auxiliary power management must not change session settlement. */ }
}
