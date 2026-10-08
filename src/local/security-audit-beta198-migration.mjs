const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_KEYS = [
  "account_ref", "account_version", "client_ref", "duration_ms", "error_code", "family_ref", "hash",
  "input_bytes", "outcome", "output_bytes", "previous_hash", "risk_category", "role", "sequence",
  "target_hash", "timestamp", "tool",
].sort().join(",");

export function migrateBeta198AuditState(state, maximumEvents, currentSchemaVersion) {
  if (!plainRecord(state) || Object.keys(state).sort().join(",") !== "anchor,events,identity_salt,next_sequence,schemaVersion"
      || state.schemaVersion !== 1 || !isHash(state.identity_salt) || !isHash(state.anchor)
      || !Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1) {
    throw new Error("security audit state schema is invalid");
  }
  if (!Array.isArray(state.events) || state.events.length > maximumEvents || !state.events.every(validBeta198AuditEvent)) {
    throw new Error("security audit events are invalid");
  }
  if (state.events.length && state.next_sequence <= state.events.at(-1).sequence) {
    throw new Error("security audit sequence did not advance");
  }
  return { ...state, schemaVersion: currentSchemaVersion, legacy_event_count: state.events.length };
}

export function validBeta198AuditEvent(event) {
  return plainRecord(event)
    && Object.keys(event).sort().join(",") === EVENT_KEYS
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && validIsoTimestamp(event.timestamp)
    && validBoundedToken(event.outcome) && validBoundedToken(event.tool) && validBoundedText(event.risk_category, 160)
    && (event.target_hash === null || isHash(event.target_hash))
    && ["account_ref", "client_ref", "family_ref"].every((key) => event[key] === null || isHash(event[key]))
    && (event.account_version === null || Number.isSafeInteger(event.account_version))
    && validBoundedToken(event.role)
    && validBoundedNumber(event.duration_ms) && validBoundedNumber(event.input_bytes) && validBoundedNumber(event.output_bytes)
    && (event.error_code === null || validBoundedToken(event.error_code))
    && isHash(event.previous_hash) && isHash(event.hash);
}

function validIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function validBoundedToken(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function validBoundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\r\n\t\u0000-\u001f\u007f]/.test(value);
}
function validBoundedNumber(value) { return Number.isSafeInteger(value) && value >= 0; }
function isHash(value) { return typeof value === "string" && HASH_PATTERN.test(value); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
