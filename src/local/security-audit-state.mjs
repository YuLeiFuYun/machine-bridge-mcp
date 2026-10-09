import { createHash, randomBytes } from "node:crypto";
import { migrateBeta198AuditState, validBeta198AuditEvent } from "./security-audit-beta198-migration.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CURRENT_EVENT_KEYS = [
  "account_ref", "account_version", "client_ref", "duration_ms", "effect_settlement", "error_code",
  "family_ref", "hash", "input_bytes", "operation_ref", "outcome", "output_bytes", "previous_hash",
  "pseudonym_epoch", "request_delivery", "risk_category", "role", "sequence", "side_effects_started",
  "target_hash", "termination_requested", "timestamp", "tool",
].sort().join(",");

export function decodeAndVerifyAuditState(buffer, schemaVersion, maximumEvents) {
  let state;
  try { state = JSON.parse(buffer.toString("utf8")); } catch (error) {
    throw new Error("security audit state is not valid JSON", { cause: error });
  }
  if (state?.schemaVersion === schemaVersion) validateState(state, schemaVersion, maximumEvents);
  else if (schemaVersion === 3 && state?.schemaVersion === 1) state = migrateBeta198AuditState(state, maximumEvents, schemaVersion);
  else throw new Error("security audit state schema is invalid");
  let previous = state.anchor;
  for (const event of state.events) {
    if (event.previous_hash !== previous || event.hash !== eventHash(event)) {
      throw new Error("security audit hash chain verification failed");
    }
    previous = event.hash;
  }
  return state;
}

export function emptyAuditState(schemaVersion) {
  return {
    schemaVersion,
    ...(schemaVersion === 3 ? { legacy_event_count: 0 } : {}),
    identity_salt: randomBytes(32).toString("hex"),
    anchor: randomBytes(32).toString("hex"),
    next_sequence: 1,
    events: [],
  };
}

export function copyAuditState(state) {
  return { ...state, events: [...state.events] };
}

export function appendAuditRecords(state, records) {
  for (const record of records) state.events.push(buildEvent(record?.input || {}, state, record?.nowMs));
}

export function boundedAuditStateContent(state, maximumEvents, maximumBytes) {
  const events = state.events;
  const eventBytes = events.map((event) => Buffer.byteLength(JSON.stringify(event)));
  let start = Math.max(0, events.length - maximumEvents);
  let retained = events.length - start;
  let bytes = Buffer.byteLength(`${JSON.stringify({ ...state, events: [] })}\n`);
  for (let index = start; index < events.length; index += 1) bytes += eventBytes[index];
  if (retained > 1) bytes += retained - 1;

  while (bytes > maximumBytes && start < events.length) {
    bytes -= eventBytes[start];
    if (retained > 1) bytes -= 1;
    start += 1;
    retained -= 1;
  }
  if (start > 0) state.anchor = events[start - 1].hash;
  if (Number.isSafeInteger(state.legacy_event_count)) {
    state.legacy_event_count = Math.max(0, state.legacy_event_count - start);
  }
  state.events = events.slice(start);

  const content = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("security audit state exceeds its size limit");
  return content;
}

function buildEvent(input, state, nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new Error("security audit timestamp is invalid");
  if (!isHash(input?.pseudonymEpoch)) throw new Error("security audit pseudonym epoch is invalid");
  const timestamp = new Date(nowMs).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("security audit timestamp is invalid");
  const principal = input.principal && typeof input.principal === "object" ? input.principal : {};
  const event = {
    sequence: state.next_sequence,
    timestamp,
    outcome: boundedToken(input.outcome, "unknown"),
    tool: boundedToken(input.tool, "unknown"),
    risk_category: boundedText(input.riskCategory, "ordinary operation", 160),
    target_hash: typeof input.targetHash === "string" && HASH_PATTERN.test(input.targetHash) ? input.targetHash : null,
    pseudonym_epoch: input.pseudonymEpoch,
    operation_ref: isHash(input.operationRef) ? input.operationRef : null,
    account_ref: principal.accountId ? privateReference(state.identity_salt, principal.accountId) : null,
    client_ref: principal.clientId ? privateReference(state.identity_salt, principal.clientId) : null,
    family_ref: principal.familyId ? privateReference(state.identity_salt, principal.familyId) : null,
    account_version: Number.isSafeInteger(principal.accountVersion) ? principal.accountVersion : null,
    role: boundedToken(principal.role, principal.kind === "local" ? "local" : "unknown"),
    duration_ms: boundedNumber(input.durationMs),
    input_bytes: boundedNumber(input.inputBytes),
    output_bytes: boundedNumber(input.outputBytes),
    error_code: input.errorCode ? boundedToken(input.errorCode, "unknown") : null,
    request_delivery: exactToken(input.requestDelivery, ["sent", "unknown"]),
    side_effects_started: exactSideEffectsStarted(input.sideEffectsStarted),
    effect_settlement: exactToken(input.effectSettlement, ["unknown", "pending"]),
    termination_requested: typeof input.terminationRequested === "boolean" ? input.terminationRequested : null,
    previous_hash: state.events.at(-1)?.hash || state.anchor,
  };
  const completed = { ...event, hash: eventHash(event) };
  state.next_sequence += 1;
  return completed;
}

function validateState(state, schemaVersion, maximumEvents) {
  if (!plainRecord(state) || state.schemaVersion !== schemaVersion) throw new Error("security audit state schema is invalid");
  if (schemaVersion !== 3 || Object.keys(state).sort().join(",") !== "anchor,events,identity_salt,legacy_event_count,next_sequence,schemaVersion"
      || !Number.isSafeInteger(state.legacy_event_count) || state.legacy_event_count < 0) {
    throw new Error("security audit state schema is invalid");
  }
  if (!isHash(state.identity_salt) || !isHash(state.anchor)) {
    throw new Error("security audit state identity is invalid");
  }
  if (!Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1) {
    throw new Error("security audit sequence is invalid");
  }
  if (!Array.isArray(state.events) || state.events.length > maximumEvents || state.legacy_event_count > state.events.length
      || !state.events.every((event, index) => index < state.legacy_event_count ? validBeta198AuditEvent(event) : validEvent(event))) {
    throw new Error("security audit events are invalid");
  }
  if (state.events.length && state.next_sequence <= state.events.at(-1).sequence) {
    throw new Error("security audit sequence did not advance");
  }
}

function validEvent(event) {
  return plainRecord(event)
    && Object.keys(event).sort().join(",") === CURRENT_EVENT_KEYS
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && validIsoTimestamp(event.timestamp)
    && validStoredToken(event.outcome) && validStoredToken(event.tool) && validStoredText(event.risk_category, 160)
    && (event.target_hash === null || isHash(event.target_hash))
    && isHash(event.pseudonym_epoch)
    && (event.operation_ref === null || isHash(event.operation_ref))
    && ["account_ref", "client_ref", "family_ref"].every((key) => event[key] === null || isHash(event[key]))
    && (event.account_version === null || Number.isSafeInteger(event.account_version))
    && validStoredToken(event.role)
    && validStoredNumber(event.duration_ms) && validStoredNumber(event.input_bytes) && validStoredNumber(event.output_bytes)
    && (event.error_code === null || validStoredToken(event.error_code))
    && (event.request_delivery === null || exactToken(event.request_delivery, ["sent", "unknown"]) !== null)
    && (event.side_effects_started === null || typeof event.side_effects_started === "boolean" || event.side_effects_started === "unknown")
    && (event.effect_settlement === null || exactToken(event.effect_settlement, ["unknown", "pending"]) !== null)
    && (event.termination_requested === null || typeof event.termination_requested === "boolean")
    && isHash(event.previous_hash) && isHash(event.hash);
}

function eventHash(event) {
  const value = { ...event };
  delete value.hash;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function privateReference(salt, value) {
  return typeof value === "string" && value ? createHash("sha256").update(salt).update("\0").update(value).digest("hex") : null;
}

function boundedToken(value, fallback) {
  return (typeof value === "string" ? value : fallback).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128) || fallback;
}
function boundedText(value, fallback, maximum) {
  return (typeof value === "string" ? value : fallback).replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) || fallback;
}
function boundedNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0; }
function exactToken(value, allowed) { return typeof value === "string" && allowed.includes(value) ? value : null; }
function exactSideEffectsStarted(value) { return typeof value === "boolean" || value === "unknown" ? value : null; }
function validIsoTimestamp(value) { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function validStoredToken(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function validStoredText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\r\n\t\u0000-\u001f\u007f]/.test(value); }
function validStoredNumber(value) { return Number.isSafeInteger(value) && value >= 0; }
function isHash(value) { return typeof value === "string" && HASH_PATTERN.test(value); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
