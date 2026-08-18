export function beginRemoteProcessSessionActivity(context, guard) {
  if (context?.origin !== "relay" || !guard) return false;
  try { guard.beginActivity?.(); } catch { /* Auxiliary power management must not change session startup. */ }
  return true;
}

export function endRemoteProcessSessionActivity(held, guard) {
  if (!held || !guard) return;
  try { guard.endActivity?.(); } catch { /* Auxiliary power management must not change session settlement. */ }
}
