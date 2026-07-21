import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.mjs";
import { OPERATION_APPROVAL_SCOPES, classifyOperation } from "./operation-risk.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { withOperationStateLock } from "./operation-state-lock.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_PENDING = 100;
const MAX_LEASES = 256;
const PENDING_TTL_SECONDS = 10 * 60;
const DEFAULT_LEASE_SECONDS = 60 * 60;
const MAX_LEASE_SECONDS = 12 * 60 * 60;
const FULL_MAX_LEASE_SECONDS = 8 * 60 * 60;

export { OPERATION_APPROVAL_SCOPES, classifyOperation };

const SCOPE_SET = new Set(OPERATION_APPROVAL_SCOPES);

export class OperationAuthorizer {
  constructor(options = {}) {
    this.workspace = path.resolve(String(options.workspace || process.cwd()));
    this.root = options.root ? path.resolve(String(options.root)) : "";
    this.resolveExistingPath = options.resolveExistingPath;
    this.resolveWritePath = options.resolveWritePath;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.queue = Promise.resolve();
  }

  async authorize(operation) {
    if (operation?.context?.origin !== "relay") return { allowed: true, source: "local" };
    const authorization = operation.request?.authorization;
    const accountId = String(authorization?.account_id || "");
    const clientId = String(authorization?.client_id || "");
    const role = String(authorization?.role || "").trim().toLowerCase();
    if (!/^acct_[A-Za-z0-9_-]{20,96}$/.test(accountId) || !/^mcp_client_[A-Za-z0-9_-]{43}$/.test(clientId)) {
      throw new BridgeError("authorization_denied", "relay operation is missing authenticated client identity");
    }
    if (role === "owner") {
      return {
        allowed: true,
        source: "authenticated-owner",
        accountId,
        clientId,
      };
    }
    const requirement = await classifyOperation(operation.tool, operation.args, {
      workspace: this.workspace,
      resolveExistingPath: this.resolveExistingPath,
      resolveWritePath: this.resolveWritePath,
    });
    if (!requirement) return { allowed: true, source: "automatic" };
    if (!this.root) throw new BridgeError("authorization_denied", "local operation approval storage is unavailable");

    const requiredScopes = normalizeScopes(requirement.scopes || [requirement.scope]);
    const matches = matchingLeases(this.root, { accountId, clientId, scopes: requiredScopes }, this.now());
    const missingScopes = requiredScopes.filter((scope) => !matches.byScope.has(scope));
    if (!missingScopes.length) {
      const leaseIds = [...new Set(matches.leases.map((lease) => lease.id))];
      return {
        allowed: true,
        source: "lease",
        leaseId: leaseIds[0],
        leaseIds,
        scope: requiredScopes[0],
        scopes: requiredScopes,
      };
    }

    const pending = await this.enqueue(() => recordPendingApproval(this.root, {
      accountId,
      clientId,
      tool: operation.tool,
      scopes: missingScopes,
      category: requirement.category,
      targetHash: requirement.targetHash,
    }, this.now()));
    const scopeText = missingScopes.join(", ");
    throw new BridgeError(
      "authorization_denied",
      `local approval required for ${requirement.category} (${scopeText}); approve the missing scopes with: machine-mcp approval approve ${pending.id} --duration 1h; or open an explicit temporary full window with: machine-mcp approval approve ${pending.id} --full`,
      {
        retryable: true,
        details: {
          reason: "local_approval_required",
          approval_id: pending.id,
          scope: missingScopes[0],
          scopes: missingScopes,
          required_scopes: requiredScopes,
          expires_at: pending.expires_at,
          approve_command: `machine-mcp approval approve ${pending.id} --duration 1h`,
          full_command: `machine-mcp approval approve ${pending.id} --full`,
        },
      },
    );
  }

  enqueue(callback) {
    const result = this.queue.then(callback, callback);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function listOperationApprovals(root, now = Date.now()) {
  return {
    leases: currentLeases(root, now),
    pending: currentPending(root, now),
  };
}

export async function approvePendingOperation(root, pendingId, duration = "1h", now = Date.now(), scopeOverride = "") {
  if (scopeOverride && scopeOverride !== "full") throw new Error("pending approval scopes may only be elevated to full");
  return withOperationStateLock(root, async () => {
    const pendingState = readPendingState(root);
    const leaseState = readLeaseState(root);
    const current = epochSeconds(now);
    const pending = pendingState.pending.find((entry) => entry.id === String(pendingId || "") && entry.expires_at > current);
    if (!pending) throw new Error("pending approval was not found or has expired");
    const scopes = scopeOverride ? [scopeOverride] : pending.scopes;
    let lease = leaseState.leases.find((entry) => entry.source_approval_id === pending.id && entry.expires_at > current);
    if (!lease) {
      lease = appendLease(leaseState, {
        accountId: pending.account_id,
        clientId: pending.client_id,
        scopes,
        duration,
        sourceApprovalId: pending.id,
      }, now);
      writeJson(leasePath(root), leaseState);
    }
    pendingState.pending = pendingState.pending.filter((entry) => entry.id !== pending.id && entry.expires_at > current);
    writeJson(pendingPath(root), pendingState);
    return lease;
  });
}

export async function grantOperationLease(root, { accountId = "*", clientId, scope, duration = "1h" }, now = Date.now()) {
  if (!/^mcp_client_[A-Za-z0-9_-]{43}$/.test(String(clientId || "")) && clientId !== "*") {
    throw new Error("approval grant requires a valid OAuth client id or *");
  }
  if (accountId !== "*" && !/^acct_[A-Za-z0-9_-]{20,96}$/.test(String(accountId || ""))) {
    throw new Error("approval account id is invalid");
  }
  return withOperationStateLock(root, async () => {
    const state = readLeaseState(root);
    const lease = appendLease(state, { accountId, clientId, scopes: [scope], duration }, now);
    writeJson(leasePath(root), state);
    return lease;
  });
}

export async function revokeOperationLease(root, leaseId, now = Date.now()) {
  return withOperationStateLock(root, async () => {
    const state = readLeaseState(root);
    const current = epochSeconds(now);
    const requested = String(leaseId || "");
    const removed = state.leases.some((lease) => lease.id === requested && lease.expires_at > current);
    const before = state.leases.length;
    state.leases = state.leases.filter((lease) => lease.expires_at > current && lease.id !== requested);
    if (state.leases.length !== before) writeJson(leasePath(root), state);
    return removed;
  });
}

export async function clearOperationLeases(root) {
  return withOperationStateLock(root, async () => {
    writeJson(leasePath(root), emptyLeaseState());
  });
}

export function parseApprovalDuration(value, scopes = "") {
  const text = String(value || "1h").trim().toLowerCase();
  const match = /^(\d+)(m|h)$/.exec(text);
  if (!match) throw new Error("approval duration must use minutes or hours, for example 30m or 2h");
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : 60);
  const normalizedScopes = normalizeScopes(Array.isArray(scopes) ? scopes : [scopes]);
  const maximum = normalizedScopes.includes("full") ? FULL_MAX_LEASE_SECONDS : MAX_LEASE_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > maximum) {
    throw new Error(`approval duration must be between 1m and ${maximum / 3600}h`);
  }
  return seconds;
}

async function recordPendingApproval(root, input, now) {
  return withOperationStateLock(root, async () => {
    const state = readPendingState(root);
    const current = epochSeconds(now);
    const scopes = normalizeScopes(input.scopes);
    state.pending = state.pending.filter((entry) => entry.expires_at > current);
    const existing = state.pending.find((entry) => (
      entry.account_id === input.accountId
      && entry.client_id === input.clientId
      && sameScopes(entry.scopes, scopes)
      && entry.target_hash === input.targetHash
    ));
    if (existing) return existing;
    const pending = {
      id: `approval_${randomBytes(18).toString("base64url")}`,
      account_id: input.accountId,
      client_id: input.clientId,
      tool: String(input.tool).slice(0, 128),
      scopes,
      category: String(input.category).slice(0, 160),
      target_hash: input.targetHash,
      created_at: current,
      expires_at: current + PENDING_TTL_SECONDS,
    };
    state.pending.push(pending);
    state.pending = state.pending.slice(-MAX_PENDING);
    writeJson(pendingPath(root), state);
    return pending;
  });
}

function appendLease(state, input, now) {
  const scopes = normalizeScopes(input.scopes);
  if (!scopes.length) throw new Error("capability lease requires at least one known scope");
  if (scopes.includes("full") && scopes.length !== 1) throw new Error("full capability lease cannot be combined with narrower scopes");
  const seconds = parseApprovalDuration(input.duration || `${DEFAULT_LEASE_SECONDS / 3600}h`, scopes);
  const current = epochSeconds(now);
  state.leases = state.leases.filter((lease) => lease.expires_at > current);
  if (state.leases.length >= MAX_LEASES) throw new Error(`operation capability leases exceed the maximum of ${MAX_LEASES}`);
  const lease = {
    id: `lease_${randomBytes(18).toString("base64url")}`,
    account_id: String(input.accountId || "*"),
    client_id: String(input.clientId || ""),
    scopes,
    created_at: current,
    expires_at: current + seconds,
    ...(input.sourceApprovalId ? { source_approval_id: String(input.sourceApprovalId) } : {}),
  };
  state.leases.push(lease);
  return lease;
}

function matchingLeases(root, input, now) {
  const current = epochSeconds(now);
  const candidates = currentLeases(root, now).filter((lease) => (
    (lease.account_id === "*" || lease.account_id === input.accountId)
    && (lease.client_id === "*" || lease.client_id === input.clientId)
    && lease.expires_at > current
  ));
  const byScope = new Map();
  for (const scope of input.scopes) {
    const lease = candidates.find((entry) => entry.scopes.includes("full") || entry.scopes.includes(scope));
    if (lease) byScope.set(scope, lease);
  }
  return { byScope, leases: [...byScope.values()] };
}

function currentLeases(root, now) {
  const current = epochSeconds(now);
  return readLeaseState(root).leases.filter((lease) => lease.expires_at > current);
}

function currentPending(root, now) {
  const current = epochSeconds(now);
  return readPendingState(root).pending.filter((entry) => entry.expires_at > current);
}

function readLeaseState(root) {
  return readState(leasePath(root), emptyLeaseState, "leases", validLease);
}

function readPendingState(root) {
  return readState(pendingPath(root), emptyPendingState, "pending", validPending);
}

function readState(file, empty, arrayKey, validEntry) {
  if (!existsSync(file)) return empty();
  const raw = readBoundedRegularFileSync(file, MAX_STATE_BYTES, "operation approval state");
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) {
    throw new Error("operation approval state is not valid JSON", { cause: error });
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(parsed[arrayKey])
    || !parsed[arrayKey].every(validEntry)
  ) {
    throw new Error("operation approval state schema is invalid");
  }
  return parsed;
}

function validLease(value) {
  if (!plainRecord(value)) return false;
  if (!/^lease_[A-Za-z0-9_-]{24}$/.test(value.id)) return false;
  if (!validAccountBinding(value.account_id) || !validClientBinding(value.client_id)) return false;
  if (!validScopes(value.scopes) || !validTimestampRange(value.created_at, value.expires_at)) return false;
  const maximum = value.scopes.includes("full") ? FULL_MAX_LEASE_SECONDS : MAX_LEASE_SECONDS;
  if (value.expires_at - value.created_at > maximum) return false;
  return value.source_approval_id === undefined || /^approval_[A-Za-z0-9_-]{24}$/.test(value.source_approval_id);
}

function validPending(value) {
  if (!plainRecord(value)) return false;
  return /^approval_[A-Za-z0-9_-]{24}$/.test(value.id)
    && validAccountBinding(value.account_id, false)
    && validClientBinding(value.client_id, false)
    && /^[a-z][a-z0-9_]{0,127}$/.test(value.tool)
    && validScopes(value.scopes, false)
    && typeof value.category === "string"
    && value.category.length > 0
    && value.category.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value.category)
    && /^[a-f0-9]{64}$/.test(value.target_hash)
    && validTimestampRange(value.created_at, value.expires_at)
    && value.expires_at - value.created_at === PENDING_TTL_SECONDS;
}

function validScopes(value, allowFull = true) {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATION_APPROVAL_SCOPES.length) return false;
  if (value.some((scope) => !SCOPE_SET.has(scope))) return false;
  if (!sameScopes(value, normalizeScopes(value))) return false;
  if (!allowFull && value.includes("full")) return false;
  return !value.includes("full") || value.length === 1;
}

function normalizeScopes(scopes) {
  const requested = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || "")));
  return OPERATION_APPROVAL_SCOPES.filter((scope) => requested.has(scope));
}

function sameScopes(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function validAccountBinding(value, wildcard = true) {
  return (wildcard && value === "*") || /^acct_[A-Za-z0-9_-]{20,96}$/.test(String(value || ""));
}

function validClientBinding(value, wildcard = true) {
  return (wildcard && value === "*") || /^mcp_client_[A-Za-z0-9_-]{43}$/.test(String(value || ""));
}

function validTimestampRange(createdAt, expiresAt) {
  return Number.isSafeInteger(createdAt)
    && Number.isSafeInteger(expiresAt)
    && createdAt > 0
    && expiresAt > createdAt;
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeJson(file, value) {
  ensureOwnerOnlyDirectorySync(path.dirname(file));
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("operation approval state exceeds its size limit");
  replaceFileAtomicallySync(file, content, { mode: 0o600 });
}

function leasePath(root) { return path.join(path.resolve(root), "operation-leases.json"); }
function pendingPath(root) { return path.join(path.resolve(root), "operation-pending.json"); }
function emptyLeaseState() { return { schemaVersion: SCHEMA_VERSION, leases: [] }; }
function emptyPendingState() { return { schemaVersion: SCHEMA_VERSION, pending: [] }; }
function epochSeconds(value) { return Math.floor(Number(value) / 1000); }
