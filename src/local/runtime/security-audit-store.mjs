import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "../core/exclusive-file.mjs";
import { withOwnerStateLock } from "../state/state-locks.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileWithInfoSync } from "../core/secure-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "../core/filesystem-identity.mjs";

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

// Inlined legacy beta198 migration logic
const BETA198_EVENT_KEYS = [
  "account_ref", "account_version", "client_ref", "duration_ms", "error_code", "family_ref", "hash",
  "input_bytes", "outcome", "output_bytes", "previous_hash", "risk_category", "role", "sequence",
  "target_hash", "timestamp", "tool",
].sort().join(",");

function migrateBeta198AuditState(state, maximumEvents, currentSchemaVersion) {
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

function validBeta198AuditEvent(event) {
  return plainRecord(event)
    && Object.keys(event).sort().join(",") === BETA198_EVENT_KEYS
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && validBeta198IsoTimestamp(event.timestamp)
    && validBeta198BoundedToken(event.outcome) && validBeta198BoundedToken(event.tool) && validBeta198BoundedText(event.risk_category, 160)
    && (event.target_hash === null || isHash(event.target_hash))
    && ["account_ref", "client_ref", "family_ref"].every((key) => event[key] === null || isHash(event[key]))
    && (event.account_version === null || Number.isSafeInteger(event.account_version))
    && validBeta198BoundedToken(event.role)
    && validBeta198BoundedNumber(event.duration_ms) && validBeta198BoundedNumber(event.input_bytes) && validBeta198BoundedNumber(event.output_bytes)
    && (event.error_code === null || validBeta198BoundedToken(event.error_code))
    && isHash(event.previous_hash) && isHash(event.hash);
}

function validBeta198IsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validBeta198BoundedToken(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }

function validBeta198BoundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\r\n\t\u0000-\u001f\u007f]/.test(value);
}

function validBeta198BoundedNumber(value) { return Number.isSafeInteger(value) && value >= 0; }
const WINDOWS_MS = Object.freeze({ one: 60_000, five: 5 * 60_000, fifteen: 15 * 60_000, sixty: 60 * 60_000 });

const PROCESS_HELPERS = new Set(["exec_command", "run_process", "run_local_command"]);

const LARGE_RESULT_BYTES = 64 * 1024;

export function securityAuditRecentActivity(state = {}, nowMs = Date.now()) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const endMs = typeof nowMs === "number" ? nowMs : NaN;
  if (!events.length || !Number.isFinite(endMs)) return emptyActivity();
  const intents = events.filter((event) => event?.outcome === "dispatch_intent");
  const terminalEvents = events.filter((event) => event?.outcome !== "dispatch_intent");
  const recent = (windowMs) => terminalEvents.filter((event) => eventAgeMs(event, endMs) <= windowMs);
  const last15 = recent(WINDOWS_MS.fifteen);
  const intentsLast15 = intents.filter((event) => eventAgeMs(event, endMs) <= WINDOWS_MS.fifteen);
  const settledOperationRefs = new Set(terminalEvents.map((event) => event?.operation_ref).filter(validOperationRef));
  const toolCounts = new Map();
  const minuteCounts = new Map();
  const minuteOutputBytes = new Map();
  let outputBytes = 0; let maximumOutputBytes = 0; let largeResultCalls = 0;
  for (const event of last15) {
    const tool = String(event?.tool || "unknown");
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    const bucket = Math.floor(eventAgeMs(event, endMs) / 60_000);
    minuteCounts.set(bucket, (minuteCounts.get(bucket) || 0) + 1);
    const bytes = boundedOutputBytes(event?.output_bytes);
    outputBytes = boundedSum(outputBytes, bytes);
    maximumOutputBytes = Math.max(maximumOutputBytes, bytes);
    if (bytes >= LARGE_RESULT_BYTES) largeResultCalls += 1;
    minuteOutputBytes.set(bucket, boundedSum(minuteOutputBytes.get(bucket) || 0, bytes));
  }
  const topTools = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8).map(([tool, count]) => ({ tool, count }));
  return {
    coverage: "daemon_reached_relay_tool_calls_only",
    host_side_events_observable: false,
    window_end_at: new Date(endMs).toISOString(),
    calls_last_1m: recent(WINDOWS_MS.one).length,
    calls_last_5m: recent(WINDOWS_MS.five).length,
    calls_last_15m: last15.length,
    calls_last_60m: recent(WINDOWS_MS.sixty).length,
    failures_last_15m: last15.filter((event) => event?.outcome !== "completed").length,
    unknown_effect_settlements_last_15m: last15.filter((event) => event?.effect_settlement === "unknown").length,
    pending_effect_settlements_last_15m: last15.filter((event) => event?.effect_settlement === "pending").length,
    dispatch_intents_last_15m: intentsLast15.length,
    unsettled_dispatch_intents_last_15m: intentsLast15.filter((event) =>
      validOperationRef(event?.operation_ref) && !settledOperationRefs.has(event.operation_ref)).length,
    process_helper_calls_last_15m: last15.filter((event) => PROCESS_HELPERS.has(String(event?.tool || ""))).length,
    read_job_calls_last_15m: last15.filter((event) => event?.tool === "read_job").length,
    start_job_calls_last_15m: last15.filter((event) => event?.tool === "start_job").length,
    peak_calls_per_minute_last_15m: Math.max(0, ...minuteCounts.values()),
    output_bytes_last_15m: outputBytes,
    maximum_output_bytes_last_15m: maximumOutputBytes,
    large_result_calls_last_15m: largeResultCalls,
    peak_output_bytes_per_minute_last_15m: Math.max(0, ...minuteOutputBytes.values()),
    distinct_tools_last_15m: toolCounts.size,
    top_tools_last_15m: topTools,
  };
}

function boundedOutputBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedSum(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function eventAgeMs(event, endMs) {
  const timestamp = typeof event?.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, endMs - timestamp) : Number.POSITIVE_INFINITY;
}

function emptyActivity() {
  return {
    coverage: "daemon_reached_relay_tool_calls_only", host_side_events_observable: false,
    window_end_at: null, calls_last_1m: 0, calls_last_5m: 0, calls_last_15m: 0, calls_last_60m: 0,
    failures_last_15m: 0, unknown_effect_settlements_last_15m: 0, pending_effect_settlements_last_15m: 0,
    dispatch_intents_last_15m: 0, unsettled_dispatch_intents_last_15m: 0,
    process_helper_calls_last_15m: 0, read_job_calls_last_15m: 0, start_job_calls_last_15m: 0,
    peak_calls_per_minute_last_15m: 0, output_bytes_last_15m: 0, maximum_output_bytes_last_15m: 0,
    large_result_calls_last_15m: 0, peak_output_bytes_per_minute_last_15m: 0, distinct_tools_last_15m: 0, top_tools_last_15m: [],
  };
}

function validOperationRef(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export const SECURITY_AUDIT_SCHEMA_VERSION = 3;

export const SECURITY_AUDIT_MAX_EVENTS = 4096;

export const SECURITY_AUDIT_MAX_BYTES = 4 * 1024 * 1024;

export function auditFilePath(root) {
  return path.join(path.resolve(root), "security-audit.json");
}

export function readVerifiedAuditState(root) {
  return readVerifiedAuditStateWithIdentity(root).state;
}

export function createAuditStorageSession(root, options = {}) {
  const directory = path.resolve(root);
  const file = auditFilePath(directory);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const syncDirectory = typeof options.syncDirectory === "function" ? options.syncDirectory : syncAuditParentDirectory;
  let cachedState = null;
  let cachedIdentity;

  const loadVerifiedState = () => {
    const observedIdentity = inspectAuditFile(file);
    if (cachedState && sameFileIdentity(cachedIdentity, observedIdentity)) return cachedState;
    const loaded = readVerifiedAuditStateWithIdentity(directory);
    cachedState = loaded.state;
    cachedIdentity = loaded.identity;
    return cachedState;
  };

  return Object.freeze({
    snapshot: () => auditSnapshotFromState(loadVerifiedState(), now()),
    async recordBatch(records) {
      if (!Array.isArray(records) || records.length === 0) return auditSnapshotFromState(loadVerifiedState(), now());
      return withOwnerStateLock(directory, async () => {
        const state = copyAuditState(loadVerifiedState());
        appendAuditRecords(state, records);
        const content = boundedAuditStateContent(state, SECURITY_AUDIT_MAX_EVENTS, SECURITY_AUDIT_MAX_BYTES);
        cachedIdentity = writeState(file, content, syncDirectory);
        cachedState = state;
        return auditSnapshotFromState(state, now());
      }, {
        purpose: "security-audit", fileName: "security-audit.lock", label: "security audit",
      });
    },
  });
}

export async function recordAuditBatch(root, records, options = {}) {
  return createAuditStorageSession(root, options).recordBatch(records);
}

export function auditSnapshotFromState(state, nowMs = Date.now()) {
  return {
    enabled: true, healthy: true, retained: state.events.length,
    maximum: SECURITY_AUDIT_MAX_EVENTS, maximum_bytes: SECURITY_AUDIT_MAX_BYTES,
    last_event_at: state.events.at(-1)?.timestamp || null,
    last_error_class: null, content_logged: false, chain_verified: true,
    recent_activity: securityAuditRecentActivity(state, nowMs),
  };
}

export function unhealthyAuditSnapshot(error) {
  return {
    enabled: true, healthy: false, retained: 0,
    maximum: SECURITY_AUDIT_MAX_EVENTS, maximum_bytes: SECURITY_AUDIT_MAX_BYTES,
    last_event_at: null, last_error_class: auditErrorClass(error),
    content_logged: false, chain_verified: false,
  };
}

export function auditErrorClass(error) {
  return String(error?.code || error?.name || "audit_error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function readVerifiedAuditStateWithIdentity(root) {
  const file = auditFilePath(root);
  let loaded;
  try {
    loaded = readBoundedRegularFileWithInfoSync(file, SECURITY_AUDIT_MAX_BYTES, "security audit state", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return { state: emptyAuditState(SECURITY_AUDIT_SCHEMA_VERSION), identity: null };
    throw error;
  }
  return {
    state: decodeAndVerifyAuditState(loaded.buffer, SECURITY_AUDIT_SCHEMA_VERSION, SECURITY_AUDIT_MAX_EVENTS),
    identity: fileIdentity(loaded.info, loaded.identity),
  };
}

function writeState(file, content, syncDirectory) {
  ensureOwnerOnlyDirectorySync(path.dirname(file));
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  syncDirectory(path.dirname(file));
  return inspectAuditFile(file);
}

function syncAuditParentDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function inspectAuditFile(file) {
  let info;
  try { info = lstatSync(file, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("security audit state must be a regular file and not a symbolic link");
  if (Number(info.nlink) > 1) throw new Error("security audit state must not have multiple hard links");
  return fileIdentity(info);
}

function fileIdentity(info, exactIdentity = filesystemIdentity(info, "security audit state")) {
  return {
    ...exactIdentity,
    size: exactFilesystemInteger(info.size, "security audit state size"),
    mtime_ms: filesystemTimeMs(info.mtimeMs, "security audit modification time"),
    ctime_ms: filesystemTimeMs(info.ctimeMs, "security audit change time"),
  };
}

function sameFileIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return Boolean(left && right)
    && sameFilesystemIdentity(left, right) && left.size === right.size
    && left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms;
}
