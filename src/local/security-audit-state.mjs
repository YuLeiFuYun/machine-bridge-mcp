import { createHash, randomBytes } from "node:crypto";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function decodeAndVerifyAuditState(buffer, schemaVersion, maximumEvents) {
  let state;
  try { state = JSON.parse(buffer.toString("utf8")); } catch (error) {
    throw new Error("security audit state is not valid JSON", { cause: error });
  }
  validateState(state, schemaVersion, maximumEvents);
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
  state.events = events.slice(start);

  const content = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("security audit state exceeds its size limit");
  return content;
}

function buildEvent(input, state, nowMs) {
  const timestamp = new Date(Number(nowMs)).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("security audit timestamp is invalid");
  const principal = input.principal && typeof input.principal === "object" ? input.principal : {};
  const event = {
    sequence: state.next_sequence,
    timestamp,
    outcome: boundedToken(input.outcome, "unknown"),
    tool: boundedToken(input.tool, "unknown"),
    risk_category: boundedText(input.riskCategory, "ordinary operation", 160),
    target_hash: HASH_PATTERN.test(String(input.targetHash || "")) ? String(input.targetHash) : null,
    account_ref: principal.accountId ? privateReference(state.identity_salt, principal.accountId) : null,
    client_ref: principal.clientId ? privateReference(state.identity_salt, principal.clientId) : null,
    family_ref: principal.familyId ? privateReference(state.identity_salt, principal.familyId) : null,
    account_version: Number.isSafeInteger(principal.accountVersion) ? principal.accountVersion : null,
    role: boundedToken(principal.role, principal.kind === "local" ? "local" : "unknown"),
    duration_ms: boundedNumber(input.durationMs),
    input_bytes: boundedNumber(input.inputBytes),
    output_bytes: boundedNumber(input.outputBytes),
    error_code: input.errorCode ? boundedToken(input.errorCode, "unknown") : null,
    previous_hash: state.events.at(-1)?.hash || state.anchor,
  };
  const completed = { ...event, hash: eventHash(event) };
  state.next_sequence += 1;
  return completed;
}

function validateState(state, schemaVersion, maximumEvents) {
  if (!plainRecord(state) || state.schemaVersion !== schemaVersion) throw new Error("security audit state schema is invalid");
  if (!HASH_PATTERN.test(state.identity_salt) || !HASH_PATTERN.test(state.anchor)) {
    throw new Error("security audit state identity is invalid");
  }
  if (!Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1) {
    throw new Error("security audit sequence is invalid");
  }
  if (!Array.isArray(state.events) || state.events.length > maximumEvents || !state.events.every(validEvent)) {
    throw new Error("security audit events are invalid");
  }
  if (state.events.length && state.next_sequence <= state.events.at(-1).sequence) {
    throw new Error("security audit sequence did not advance");
  }
}

function validEvent(event) {
  return plainRecord(event)
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && Number.isFinite(Date.parse(String(event.timestamp || "")))
    && typeof event.outcome === "string" && typeof event.tool === "string" && typeof event.risk_category === "string"
    && (event.target_hash === null || HASH_PATTERN.test(event.target_hash))
    && ["account_ref", "client_ref", "family_ref"].every((key) => event[key] === null || HASH_PATTERN.test(event[key]))
    && (event.account_version === null || Number.isSafeInteger(event.account_version))
    && typeof event.role === "string"
    && Number.isFinite(event.duration_ms) && Number.isFinite(event.input_bytes) && Number.isFinite(event.output_bytes)
    && (event.error_code === null || typeof event.error_code === "string")
    && HASH_PATTERN.test(event.previous_hash) && HASH_PATTERN.test(event.hash);
}

function eventHash(event) {
  const value = { ...event };
  delete value.hash;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function privateReference(salt, value) {
  return createHash("sha256").update(salt).update("\0").update(String(value)).digest("hex");
}

function boundedToken(value, fallback) {
  return String(value || fallback).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128) || fallback;
}
function boundedText(value, fallback, maximum) {
  return String(value || fallback).replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) || fallback;
}
function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
}
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
