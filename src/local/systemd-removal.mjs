export function systemdRemovalDecision({ definitionPresent, disableCode, status }) {
  const state = String(status?.state || "unknown");
  const active = status?.active;
  if (active === true || ["activating", "deactivating", "reloading", "maintenance"].includes(state)) {
    return { removable: false, alreadyAbsent: false, reason: "service_active_or_transitioning" };
  }
  const safelyInactive = active === false && ["inactive", "failed"].includes(state);
  const safelyAbsent = definitionPresent !== true && active === false && state === "unknown";
  if (!safelyInactive && !safelyAbsent) {
    return { removable: false, alreadyAbsent: false, reason: "status_unavailable" };
  }
  if (definitionPresent === true && Number(disableCode) !== 0) {
    return { removable: false, alreadyAbsent: false, reason: "disable_failed" };
  }
  return {
    removable: true,
    alreadyAbsent: definitionPresent !== true,
    reason: definitionPresent === true ? "disabled" : "already_absent",
  };
}
