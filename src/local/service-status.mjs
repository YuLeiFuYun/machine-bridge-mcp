const SYSTEMD_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "unknown"]);
export const LAUNCHD_MISSING_SERVICE_CODE = 113;

export function launchdStatusSummary({ installed, definition, result }) {
  const detail = String(result?.stdout || "");
  const queryCode = Number(result?.code);
  const loaded = queryCode === 0;
  const missing = queryCode === LAUNCHD_MISSING_SERVICE_CODE;
  const statusAvailable = loaded || missing;
  const state = loaded ? launchdField(detail, "state") || "loaded" : missing ? "inactive" : "unknown";
  const pid = loaded ? positiveMatch(detail, /\bpid = (\d+)/) : null;
  return {
    ok: Boolean(installed),
    provider: "launchd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    loaded,
    active: statusAvailable ? loaded && (pid !== null || state === "running") : null,
    state,
    status_available: statusAvailable,
    status_query_code: Number.isInteger(queryCode) ? queryCode : null,
    pid,
    runs: loaded ? positiveMatch(detail, /\bruns = (\d+)/) : null,
    last_termination_signal: loaded ? textMatch(detail, /\blast terminating signal = ([^\n]+)/) : null,
  };
}

export function systemdStatusSummary({ installed, definition, result }) {
  const firstLine = String(result?.stdout || "").split(/\r?\n/, 1)[0].trim().toLowerCase();
  const statusAvailable = SYSTEMD_STATES.has(firstLine);
  const state = statusAvailable ? firstLine : "unknown";
  const safelyAbsent = statusAvailable && state === "unknown" && !installed;
  const safelyInactive = statusAvailable && ["inactive", "failed"].includes(state);
  const active = state === "active" ? true : safelyInactive || safelyAbsent ? false : null;
  const queryCode = Number(result?.code);
  return {
    ok: Boolean(installed),
    provider: "systemd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    active,
    state,
    status_available: statusAvailable,
    status_query_code: Number.isInteger(queryCode) ? queryCode : null,
  };
}

function launchdField(value, field) {
  const escaped = String(field || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return textMatch(value, new RegExp(`\\b${escaped} = ([^\\n]+)`));
}

function textMatch(value, pattern) {
  return pattern.exec(String(value || ""))?.[1]?.trim() || null;
}

function positiveMatch(value, pattern) {
  const parsed = Number(textMatch(value, pattern));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
