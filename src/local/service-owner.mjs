// @ts-check

import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { ensureOwnerOnlyDir, machineServiceControlRoot } from "./state.mjs";

const SCHEMA_VERSION = 1;
const MAX_BYTES = 64 * 1024;
const FILE_NAME = "service-owner.json";
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const TRANSACTION = /^[A-Za-z0-9_-]{20,128}$/;

/** @typedef {{ schemaVersion: 1, status: "pending" | "committed", transactionId: string, workspace: string, stateRoot: string, entryScript: string, version: string, createdAt: string, committedAt: string | null }} ServiceOwner */
/** @typedef {{ workspace?: unknown, stateRoot?: unknown, entryScript?: unknown, version?: unknown }} ServiceOwnerSpec */
/** @typedef {{ controlRoot?: string }} ServiceOwnerOptions */

/** @param {ServiceOwnerOptions} [options] */ export function serviceOwnerPath(options = {}) {
  return path.join(machineServiceControlRoot(options), FILE_NAME);
}

/** @param {ServiceOwnerSpec} spec @param {ServiceOwnerOptions} [options] */ export function beginServiceOwnerUpdate(spec, options = {}) {
  const file = serviceOwnerPath(options);
  ensureOwnerOnlyDir(path.dirname(file));
  const previous = existsSync(file) ? readOwnerSnapshot(file) : null;
  const transactionId = randomBytes(24).toString("base64url");
  const createdAt = new Date().toISOString();
  const pending = normalizeOwner({
    schemaVersion: SCHEMA_VERSION,
    status: "pending",
    transactionId,
    workspace: spec?.workspace,
    stateRoot: spec?.stateRoot,
    entryScript: spec?.entryScript,
    version: spec?.version,
    createdAt,
    committedAt: null,
  });
  writeOwner(file, pending);
  let closed = false;
  return {
    path: file,
    owner: pending,
    commit() {
      if (closed) throw new Error("service owner transaction is already closed");
      assertCurrentTransaction(file, transactionId, "pending");
      const committed = normalizeOwner({ ...pending, status: "committed", committedAt: new Date().toISOString() });
      writeOwner(file, committed);
      closed = true;
      return committed;
    },
    rollback() {
      if (closed) return false;
      assertCurrentTransaction(file, transactionId, "pending");
      if (previous) replaceFileAtomicallySync(file, previous.raw, { mode: 0o600 });
      else rmSync(file, { force: true });
      closed = true;
      return true;
    },
  };
}

/** @param {ServiceOwnerOptions} [options] @returns {ServiceOwner | null} */ export function loadServiceOwner(options = {}) {
  const file = serviceOwnerPath(options);
  return existsSync(file) ? readOwnerSnapshot(file).owner : null;
}

/** @param {ServiceOwnerOptions} [options] @returns {ServiceOwner | null} */ export function loadCommittedServiceOwner(options = {}) {
  const owner = loadServiceOwner(options);
  if (!owner) return null;
  if (owner.status !== "committed") {
    throw new Error("machine service owner transition is incomplete; reinstall the service before starting it");
  }
  return owner;
}

/** @param {ServiceOwnerOptions} [options] */ export function removeServiceOwner(options = {}) {
  const file = serviceOwnerPath(options);
  if (!existsSync(file)) return false;
  readBoundedRegularFileSync(file, MAX_BYTES, "machine service owner file", {
    verifyPathIdentity: true, rejectMultipleLinks: true,
  });
  rmSync(file, { force: true });
  return true;
}

/** @param {string} file @returns {{ owner: ServiceOwner, raw: Buffer }} */ function readOwnerSnapshot(file) {
  const raw = readBoundedRegularFileSync(file, MAX_BYTES, "machine service owner file");
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch (error) { throw new Error("machine service owner file is not valid JSON", { cause: error }); }
  return { owner: normalizeOwner(parsed), raw };
}

/** @param {string} file @param {ServiceOwner} owner */ function writeOwner(file, owner) {
  const content = `${JSON.stringify(owner, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("machine service owner record exceeds the size limit");
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
}

/** @param {string} file @param {string} transactionId @param {"pending" | "committed"} status */ function assertCurrentTransaction(file, transactionId, status) {
  const current = readOwnerSnapshot(file).owner;
  if (current.transactionId !== transactionId || current.status !== status) {
    throw new Error("machine service owner transaction changed before completion");
  }
}

/** @param {unknown} value @returns {ServiceOwner} */ function normalizeOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("machine service owner must be an object");
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion !== SCHEMA_VERSION) throw new Error("machine service owner schema is unsupported");
  if (record.status !== "pending" && record.status !== "committed") throw new Error("machine service owner status is invalid");
  if (typeof record.transactionId !== "string" || !TRANSACTION.test(record.transactionId)) throw new Error("machine service owner transaction id is invalid");
  if (typeof record.version !== "string" || !VERSION.test(record.version)) throw new Error("machine service owner version is invalid");
  const workspace = canonicalDirectory(record.workspace, "workspace");
  const stateRoot = canonicalDirectory(record.stateRoot, "state root");
  const entryScript = canonicalFile(record.entryScript, "entry script");
  const createdAt = isoTimestamp(record.createdAt, "createdAt");
  const committedAt = record.status === "committed" ? isoTimestamp(record.committedAt, "committedAt") : null;
  return { schemaVersion: SCHEMA_VERSION, status: record.status, transactionId: record.transactionId,
    workspace, stateRoot, entryScript, version: record.version, createdAt, committedAt };
}

/** @param {unknown} value @param {string} label */ function canonicalDirectory(value, label) {
  const canonical = canonicalPath(value, label);
  if (!statSync(canonical).isDirectory()) throw new Error(`machine service owner ${label} is not a directory`);
  return canonical;
}

/** @param {unknown} value @param {string} label */ function canonicalFile(value, label) {
  const canonical = canonicalPath(value, label);
  if (!statSync(canonical).isFile()) throw new Error(`machine service owner ${label} is not a file`);
  return canonical;
}

/** @param {unknown} value @param {string} label */ function canonicalPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`machine service owner ${label} must be absolute`);
  try { return realpathSync.native ? realpathSync.native(value) : realpathSync(value); }
  catch (error) { throw new Error(`machine service owner ${label} is unavailable`, { cause: error }); }
}

/** @param {unknown} value @param {string} label */ function isoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`machine service owner ${label} is invalid`);
  return value;
}
