import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { withOwnerStateLock } from "./owner-state-lock.mjs";

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class SecurityAuditLog {
  constructor({ root = "", now = Date.now } = {}) {
    this.root = root ? path.resolve(root) : "";
    this.file = this.root ? path.join(this.root, "security-audit.json") : "";
    this.now = typeof now === "function" ? now : Date.now;
    this.queue = Promise.resolve();
    this.lastError = "";
    if (this.file && existsSync(this.file)) {
      try { this.readVerifiedState(); } catch (error) { this.lastError = errorClass(error); }
    }
  }

  record(input = {}) {
    if (!this.file) return Promise.resolve(false);
    const operation = async () => {
      try {
        return await withOwnerStateLock(this.root, async () => {
          const state = this.readVerifiedState();
          const event = buildEvent(input, state, this.now());
          state.events.push(event);
          while (state.events.length > MAX_EVENTS) {
            const removed = state.events.shift();
            state.anchor = removed.hash;
          }
          writeState(this.file, state);
          this.lastError = "";
          return true;
        }, {
          purpose: "security-audit", fileName: "security-audit.lock", label: "security audit",
        });
      } catch (error) {
        this.lastError = errorClass(error);
        return false;
      }
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  snapshot() {
    if (!this.file) return { enabled: false, healthy: true, retained: 0, maximum: MAX_EVENTS };
    try {
      const state = this.readVerifiedState();
      return {
        enabled: true,
        healthy: !this.lastError,
        retained: state.events.length,
        maximum: MAX_EVENTS,
        last_event_at: state.events.at(-1)?.timestamp || null,
        last_error_class: this.lastError || null,
        content_logged: false,
        chain_verified: true,
      };
    } catch (error) {
      return {
        enabled: true,
        healthy: false,
        retained: 0,
        maximum: MAX_EVENTS,
        last_event_at: null,
        last_error_class: errorClass(error),
        content_logged: false,
        chain_verified: false,
      };
    }
  }

  readVerifiedState() {
    if (!existsSync(this.file)) return emptyState();
    const raw = readBoundedRegularFileSync(this.file, MAX_BYTES, "security audit state");
    let state;
    try { state = JSON.parse(raw.toString("utf8")); } catch (error) {
      throw new Error("security audit state is not valid JSON", { cause: error });
    }
    validateState(state);
    let previous = state.anchor;
    for (const event of state.events) {
      if (event.previous_hash !== previous || event.hash !== eventHash(event)) {
        throw new Error("security audit hash chain verification failed");
      }
      previous = event.hash;
    }
    return state;
  }
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

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    identity_salt: randomBytes(32).toString("hex"),
    anchor: randomBytes(32).toString("hex"),
    next_sequence: 1,
    events: [],
  };
}

function validateState(state) {
  if (!plainRecord(state) || state.schemaVersion !== SCHEMA_VERSION) throw new Error("security audit state schema is invalid");
  if (!HASH_PATTERN.test(state.identity_salt) || !HASH_PATTERN.test(state.anchor)) throw new Error("security audit state identity is invalid");
  if (!Number.isSafeInteger(state.next_sequence) || state.next_sequence < 1) throw new Error("security audit sequence is invalid");
  if (!Array.isArray(state.events) || state.events.length > MAX_EVENTS || !state.events.every(validEvent)) {
    throw new Error("security audit events are invalid");
  }
  if (state.events.length && state.next_sequence <= state.events.at(-1).sequence) throw new Error("security audit sequence did not advance");
}

function validEvent(event) {
  return plainRecord(event)
    && Number.isSafeInteger(event.sequence)
    && event.sequence > 0
    && Number.isFinite(Date.parse(String(event.timestamp || "")))
    && typeof event.outcome === "string"
    && typeof event.tool === "string"
    && typeof event.risk_category === "string"
    && (event.target_hash === null || HASH_PATTERN.test(event.target_hash))
    && ["account_ref", "client_ref", "family_ref"].every((key) => event[key] === null || HASH_PATTERN.test(event[key]))
    && (event.account_version === null || Number.isSafeInteger(event.account_version))
    && typeof event.role === "string"
    && Number.isFinite(event.duration_ms)
    && Number.isFinite(event.input_bytes)
    && Number.isFinite(event.output_bytes)
    && (event.error_code === null || typeof event.error_code === "string")
    && HASH_PATTERN.test(event.previous_hash)
    && HASH_PATTERN.test(event.hash);
}

function eventHash(event) {
  const value = { ...event };
  delete value.hash;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function privateReference(salt, value) {
  return createHash("sha256").update(salt).update("\0").update(String(value)).digest("hex");
}

function writeState(file, state) {
  ensureOwnerOnlyDirectorySync(path.dirname(file));
  const content = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("security audit state exceeds its size limit");
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
}

function boundedToken(value, fallback) {
  const text = String(value || fallback).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return text || fallback;
}

function boundedText(value, fallback, maximum) {
  return String(value || fallback).replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) || fallback;
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
}

function errorClass(error) {
  return String(error?.code || error?.name || "audit_error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
