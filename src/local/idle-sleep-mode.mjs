export const IDLE_SLEEP_MODES = Object.freeze(["activity", "ac-continuous", "continuous"]);

export function normalizeIdleSleepMode(value = "activity") {
  const mode = String(value || "activity").trim().toLowerCase();
  if (!IDLE_SLEEP_MODES.includes(mode)) {
    throw new Error(`idle-sleep mode must be one of: ${IDLE_SLEEP_MODES.join(", ")}`);
  }
  return mode;
}
