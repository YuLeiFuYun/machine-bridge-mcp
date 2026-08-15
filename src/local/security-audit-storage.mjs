import { lstatSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { withOwnerStateLock } from "./owner-state-lock.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileWithInfoSync } from "./secure-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import {
  appendAuditRecords,
  boundedAuditStateContent,
  copyAuditState,
  decodeAndVerifyAuditState,
  emptyAuditState,
} from "./security-audit-state.mjs";

export const SECURITY_AUDIT_SCHEMA_VERSION = 1;
export const SECURITY_AUDIT_MAX_EVENTS = 4096;
export const SECURITY_AUDIT_MAX_BYTES = 4 * 1024 * 1024;

export function auditFilePath(root) {
  return path.join(path.resolve(root), "security-audit.json");
}

export function readVerifiedAuditState(root) {
  return readVerifiedAuditStateWithIdentity(root).state;
}

export function createAuditStorageSession(root) {
  const directory = path.resolve(root);
  const file = auditFilePath(directory);
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
    snapshot: () => auditSnapshotFromState(loadVerifiedState()),
    async recordBatch(records) {
      if (!Array.isArray(records) || records.length === 0) return auditSnapshotFromState(loadVerifiedState());
      return withOwnerStateLock(directory, async () => {
        const state = copyAuditState(loadVerifiedState());
        appendAuditRecords(state, records);
        const content = boundedAuditStateContent(state, SECURITY_AUDIT_MAX_EVENTS, SECURITY_AUDIT_MAX_BYTES);
        cachedIdentity = writeState(file, content);
        cachedState = state;
        return auditSnapshotFromState(state);
      }, {
        purpose: "security-audit", fileName: "security-audit.lock", label: "security audit",
      });
    },
  });
}

export async function recordAuditBatch(root, records) {
  return createAuditStorageSession(root).recordBatch(records);
}

export function auditSnapshotFromState(state) {
  return {
    enabled: true, healthy: true, retained: state.events.length,
    maximum: SECURITY_AUDIT_MAX_EVENTS, maximum_bytes: SECURITY_AUDIT_MAX_BYTES,
    last_event_at: state.events.at(-1)?.timestamp || null,
    last_error_class: null, content_logged: false, chain_verified: true,
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

function writeState(file, content) {
  ensureOwnerOnlyDirectorySync(path.dirname(file));
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
  return inspectAuditFile(file);
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
