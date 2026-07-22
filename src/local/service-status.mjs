const SYSTEMD_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "unknown"]);

export function launchdStatusSummary({ installed, definition, result }) {
  const detail = String(result?.stdout || "");
  const loaded = Number(result?.code) === 0;
  const state = launchdField(detail, "state") || (loaded ? "loaded" : "inactive");
  const pid = positiveMatch(detail, /\bpid = (\d+)/);
  return {
    ok: Boolean(installed),
    provider: "launchd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    loaded,
    active: loaded && (pid !== null || state === "running"),
    state,
    pid,
    runs: positiveMatch(detail, /\bruns = (\d+)/),
    last_termination_signal: textMatch(detail, /\blast terminating signal = ([^\n]+)/),
  };
}

export function systemdStatusSummary({ installed, definition, result }) {
  const firstLine = String(result?.stdout || "").split(/\r?\n/, 1)[0].trim().toLowerCase();
  const state = SYSTEMD_STATES.has(firstLine) ? firstLine : "unknown";
  return {
    ok: Boolean(installed),
    provider: "systemd",
    installed: Boolean(installed),
    definition: String(definition || ""),
    active: state === "active",
    state,
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
