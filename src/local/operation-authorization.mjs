import { existsSync } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.mjs";
import { OPERATION_APPROVAL_SCOPES, classifyOperation } from "./operation-risk.mjs";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { withOperationStateLock } from "./operation-state-lock.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const SCHEMA_VERSION = 2;
const MAX_STATE_BYTES = 256 * 1024;
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
    this.protectedRoots = Array.isArray(options.protectedRoots) ? options.protectedRoots.filter(Boolean).map((value) => path.resolve(String(value))) : [];
    this.now = typeof options.now === "function" ? options.now : Date.now;
  }

  async authorize(operation) {
    if (operation?.context?.origin !== "relay") {
      return { allowed: true, source: "local", category: "local operation", scopes: [], targetHash: "" };
    }
    const authority = operation.context?.authority;
    const principal = authority?.principal;
    if (!authority || principal?.kind !== "account") {
      throw new BridgeError("authorization_denied", "relay operation is missing effective authority context");
    }
    const requirement = await classifyOperation(operation.tool, operation.args, {
      workspace: this.workspace,
      resolveExistingPath: (value) => this.resolveExistingPath(value, operation.context),
      resolveWritePath: (value) => this.resolveWritePath(value, operation.context),
    });
    if (requirement && requirement.canonicalTargets?.some((target) => this.protectedRoots.some((root) => isWithinRoot(root, target)))) {
      throw new BridgeError("authorization_denied", "Machine Bridge control-plane state cannot be accessed through generic path-based remote tools", {
        details: { reason: "control_plane_state_protected", tool: operation.tool },
      });
    }
    if (!requirement) {
      return {
        allowed: true,
        source: authority.owner ? "trusted-owner" : "role-ceiling",
        category: "ordinary operation",
        scopes: [],
        targetHash: "",
      };
    }
    assertRequirementWithinAuthority(requirement, authority, operation.tool);
    return {
      allowed: true,
      source: authority.owner ? "trusted-owner" : "role-ceiling",
      category: requirement.category,
      scopes: normalizeScopes(requirement.scopes || [requirement.scope]),
      targetHash: requirement.targetHash,
    };
  }
}

function isWithinRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertRequirementWithinAuthority(requirement, authority, tool) {
  const scopes = normalizeScopes(requirement.scopes || [requirement.scope]);
  const policy = authority.effectivePolicy;
  const role = authority.principal.role;
  if (scopes.includes("full") && !authority.owner) {
    throw new BridgeError("authorization_denied", "full authority is reserved for the owner account");
  }
  if ((scopes.includes("external-read") || scopes.includes("external-write")) && !policy.unrestrictedPaths) {
    throw new BridgeError("authorization_denied", `account role ${role} is confined to the selected workspace`, {
      details: { reason: "account_role_path_ceiling", tool, role },
    });
  }
  if ((scopes.includes("sensitive-read") || scopes.includes("sensitive-write") || scopes.includes("credential-operation")) && !authority.owner) {
    throw new BridgeError("authorization_denied", `account role ${role} cannot access credential or persistence-sensitive targets`, {
      details: { reason: "account_role_sensitive_ceiling", tool, role },
    });
  }
  if (!authority.owner && (tool === "stage_job" || tool === "start_job")) {
    throw new BridgeError("authorization_denied", `account role ${role} cannot create persistent execution plans`, {
      details: { reason: "account_role_persistent_execution_ceiling", tool, role },
    });
  }
  if (scopes.includes("shell") && !policy.allowExec) {
    throw new BridgeError("authorization_denied", `account role ${role} cannot execute local processes`, {
      details: { reason: "account_role_execution_ceiling", tool, role },
    });
  }
  if ((scopes.includes("browser-session") || scopes.includes("application-control") || scopes.includes("data-export")) && !authority.owner) {
    throw new BridgeError("authorization_denied", `account role ${role} cannot control the owner browser or desktop session`, {
      details: { reason: "account_role_interactive_ceiling", tool, role },
    });
  }
}

// Legacy lease administration is retained only for migration and incident-response
// tooling. Runtime authorization no longer consumes leases and never asks a user to
// copy an approval ID into a terminal.
export function listOperationApprovals(root, now = Date.now()) {
  return { leases: currentLeases(root, now), pending: [] };
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

function currentLeases(root, now) {
  const current = epochSeconds(now);
  return readLeaseState(root).leases.filter((lease) => lease.expires_at > current);
}

function readLeaseState(root) {
  const file = leasePath(root);
  if (!existsSync(file)) return emptyLeaseState();
  const raw = readBoundedRegularFileSync(file, MAX_STATE_BYTES, "operation approval state");
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) {
    throw new Error("operation approval state is not valid JSON", { cause: error });
  }
  if (parsed?.schemaVersion === 1 && Array.isArray(parsed.leases)) return emptyLeaseState();
  if (!plainRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.leases) || !parsed.leases.every(validLease)) {
    throw new Error("operation approval state schema is invalid");
  }
  return parsed;
}

function validLease(value) {
  if (!plainRecord(value) || !/^lease_[A-Za-z0-9_-]{24}$/.test(value.id)) return false;
  if (!validAccountBinding(value.account_id) || !validClientBinding(value.client_id)) return false;
  if (value.account_id === "*" ? value.account_version !== 0 : !Number.isSafeInteger(value.account_version) || value.account_version <= 0) return false;
  if (!validScopes(value.scopes) || !validTimestampRange(value.created_at, value.expires_at)) return false;
  const maximum = value.scopes.includes("full") ? FULL_MAX_LEASE_SECONDS : MAX_LEASE_SECONDS;
  return value.expires_at - value.created_at <= maximum;
}

function validScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATION_APPROVAL_SCOPES.length) return false;
  if (value.some((scope) => !SCOPE_SET.has(scope))) return false;
  if (!sameScopes(value, normalizeScopes(value))) return false;
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
  return Number.isSafeInteger(createdAt) && Number.isSafeInteger(expiresAt) && createdAt > 0 && expiresAt > createdAt;
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
function emptyLeaseState() { return { schemaVersion: SCHEMA_VERSION, leases: [] }; }
function epochSeconds(value) { return Math.floor(Number(value) / 1000); }
