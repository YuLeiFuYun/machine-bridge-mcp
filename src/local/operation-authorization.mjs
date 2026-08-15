import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import accessContract from "../shared/access-contract.json" with { type: "json" };
import { BridgeError } from "./errors.mjs";
import { OPERATION_APPROVAL_SCOPES, classifyOperation } from "./operation-risk.mjs";

export { OPERATION_APPROVAL_SCOPES, classifyOperation };

const OWNER_ONLY_TOOLS = new Set((accessContract.ownerOnlyTools || []).map(String));

export class OperationAuthorizer {
  constructor(options = {}) {
    this.workspace = path.resolve(String(options.workspace || process.cwd()));
    this.root = options.root ? path.resolve(String(options.root)) : "";
    this.resolveExistingPath = options.resolveExistingPath;
    this.resolveWritePath = options.resolveWritePath;
    this.protectedRoots = Array.isArray(options.protectedRoots) ? options.protectedRoots.filter(Boolean).map((value) => path.resolve(String(value))) : [];
    this.auditTargetKey = Buffer.from(options.auditTargetKey || randomBytes(32));
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
    if (!authority.owner && OWNER_ONLY_TOOLS.has(operation.tool)) {
      operation.context.operationAuthorization = {
        allowed: false,
        source: "role-ceiling",
        category: "owner-only tool",
        scopes: [],
        targetHash: "",
      };
      throw new BridgeError("authorization_denied", `account role ${principal.role} cannot use owner-only tool ${operation.tool}`, {
        details: { reason: "account_role_owner_only_tool_ceiling", tool: operation.tool, role: principal.role },
      });
    }
    const requirement = await classifyOperation(operation.tool, operation.args, {
      workspace: this.workspace,
      resolveExistingPath: (value) => this.resolveExistingPath(value, operation.context),
      resolveWritePath: (value) => this.resolveWritePath(value, operation.context),
    });
    const decision = operationDecision(requirement, authority, this.auditTargetKey);
    operation.context.operationAuthorization = { ...decision, allowed: false };
    if (requirement && requirement.canonicalTargets?.some((target) => this.protectedRoots.some((root) => isWithinRoot(root, target)))) {
      throw new BridgeError("authorization_denied", "Machine Bridge control-plane state cannot be accessed through generic path-based remote tools", {
        details: { reason: "control_plane_state_protected", tool: operation.tool },
      });
    }
    if (requirement) assertRequirementWithinAuthority(requirement, authority, operation.tool);
    return { ...decision, allowed: true };
  }
}

function operationDecision(requirement, authority, auditTargetKey) {
  return {
    source: authority.owner ? "trusted-owner" : "role-ceiling",
    category: requirement?.category || "ordinary operation",
    scopes: requirement ? normalizeScopes(requirement.scopes || [requirement.scope]) : [],
    targetHash: requirement ? auditTargetFingerprint(auditTargetKey, requirement.targetHash) : "",
  };
}

function auditTargetFingerprint(key, value) {
  return createHmac("sha256", key).update(String(value || "")).digest("hex");
}

function normalizeScopes(scopes) {
  const requested = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || "")));
  return OPERATION_APPROVAL_SCOPES.filter((scope) => requested.has(scope));
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
