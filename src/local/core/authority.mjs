// @ts-check
import { BridgeError } from "./errors.mjs";
import { intersectPolicies, normalizePolicy, policyProfile } from "./policy.mjs";
import { createHmac, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import accessContract from "../../shared/access-contract.json" with { type: "json" };
import { OPERATION_APPROVAL_SCOPES, classifyOperation } from "./operation-risk.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;

const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;

const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

/** @typedef {"reviewer" | "editor" | "operator" | "owner"} AccountRole */
/** @typedef {{account_id?: unknown, account_version?: unknown, client_id?: unknown, family_id?: unknown, role?: unknown}} RelayAuthorization */
/** @typedef {{kind: "local", role: "owner"} | {kind: "account", accountId: string, accountVersion: number, clientId: string, familyId: string, role: AccountRole}} AuthorityPrincipal */
/** @typedef {ReturnType<typeof normalizePolicy>} NormalizedPolicy */
/** @typedef {{origin: "local" | "relay", principal: AuthorityPrincipal, daemonPolicy: NormalizedPolicy, accountPolicy: NormalizedPolicy, effectivePolicy: NormalizedPolicy, owner: boolean}} AuthorityContext */
/** @typedef {{authorization?: RelayAuthorization, daemonPolicy?: unknown, origin?: "local" | "relay"}} BuildAuthorityOptions */
/** @typedef {{origin?: string, authority?: {principal?: AuthorityPrincipal, effectivePolicy?: NormalizedPolicy}}} OperationContext */
/** @typedef {{owner_kind?: unknown, owner_account_id?: unknown, owner_account_version?: unknown, owner_client_id?: unknown, owner_family_id?: unknown}} OwnedRecord */

/** @param {BuildAuthorityOptions} [options] */
export function buildAuthorityContext({ authorization = {}, daemonPolicy, origin = "local" } = {}) {
  if (origin !== "relay") {
    const policy = normalizePolicy(daemonPolicy || {});
    return Object.freeze({
      origin: "local",
      principal: Object.freeze({ kind: "local", role: "owner" }),
      daemonPolicy: policy,
      accountPolicy: policy,
      effectivePolicy: policy,
      owner: true,
    });
  }

  const accountId = authorization.account_id;
  const clientId = authorization.client_id;
  const familyId = authorization.family_id;
  const role = authorization.role;
  const accountVersion = authorization.account_version;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)
      || typeof clientId !== "string" || !CLIENT_ID.test(clientId)
      || typeof familyId !== "string" || !FAMILY_ID.test(familyId)
      || !isAccountRole(role)
      || typeof accountVersion !== "number" || !Number.isSafeInteger(accountVersion) || accountVersion <= 0) {
    throw new BridgeError("authorization_denied", "relay operation is missing authenticated principal identity");
  }
  const accountPolicy = policyProfile(roleProfile(role), "explicit");
  const normalizedDaemonPolicy = normalizePolicy(daemonPolicy || {});
  const effectivePolicy = intersectPolicies(normalizedDaemonPolicy, accountPolicy, { origin: "effective" });
  const principal = Object.freeze({
    kind: "account",
    accountId,
    accountVersion,
    clientId,
    familyId,
    role,
  });
  return Object.freeze({
    origin: "relay",
    principal,
    daemonPolicy: normalizedDaemonPolicy,
    accountPolicy,
    effectivePolicy,
    owner: role === "owner",
  });
}

/**
 * A relay operation is delegated when it acts for a non-owner account. Local owner operations
 * and owner-role relay operations retain the full local authority boundary. This predicate is
 * shared by every path that must hide sensitive files from delegated remote callers.
 * @param {unknown} context
 */
export function isDelegatedRelayContext(context) {
  const record = /** @type {Record<string, unknown>} */ (context !== null && typeof context === "object" ? context : {});
  const authority = /** @type {Record<string, unknown>} */ (record.authority !== null && typeof record.authority === "object" ? record.authority : {});
  const principal = /** @type {Record<string, unknown>} */ (authority.principal !== null && typeof authority.principal === "object" ? authority.principal : {});
  return record.origin === "relay" && principal.kind === "account"
    && principal.role !== "owner" && authority.owner !== true;
}

/** @param {OperationContext | null | undefined} context @param {NormalizedPolicy | undefined} fallbackPolicy */
export function policyForContext(context, fallbackPolicy) {
  return normalizePolicy(context?.authority?.effectivePolicy || fallbackPolicy || {});
}

const LOCAL_OWNER_PRINCIPAL = Object.freeze({ kind: "local", role: "owner" });

/**
 * Resolve the principal that owns an operation. A context that carries an authority
 * object must carry an authenticated principal; only a context with no authority
 * object at all is treated as the local owner (the default for internal local APIs).
 * A relay-marked context without a principal is always denied, never upgraded to
 * local-owner authority.
 * @param {OperationContext | null | undefined} context
 */
export function principalForContext(context) {
  const authority = context?.authority;
  const principal = authority?.principal;
  if (principal?.kind === "account") return principal;
  if (principal?.kind === "local" && principal.role === "owner") return principal;
  if (authority !== undefined || context?.origin === "relay") {
    throw new BridgeError("authorization_denied", "operation is missing explicit authenticated authority context");
  }
  return LOCAL_OWNER_PRINCIPAL;
}

/** @param {OperationContext | null | undefined} context */
export function principalBinding(context) {
  const principal = principalForContext(context);
  if (principal.kind !== "account") return { owner_kind: "local" };
  return {
    owner_kind: "account",
    owner_account_id: principal.accountId,
    owner_account_version: principal.accountVersion,
    owner_client_id: principal.clientId,
    owner_family_id: principal.familyId,
    owner_role: principal.role,
  };
}

/** @param {OwnedRecord | null | undefined} record @param {OperationContext | null | undefined} context @param {string} [label] */
export function assertOwnedByContext(record, context, label = "object") {
  const principal = principalForContext(context);
  if (principal.kind !== "account" || principal.role === "owner") return;
  if (
    record?.owner_kind !== "account"
    || record.owner_account_id !== principal.accountId
    || record.owner_account_version !== principal.accountVersion
    || record.owner_client_id !== principal.clientId
    || record.owner_family_id !== principal.familyId
  ) {
    throw new BridgeError("authorization_denied", `${label} belongs to another account or an obsolete account session`);
  }
}

/** @param {OwnedRecord | null | undefined} record @param {OperationContext | null | undefined} context */
export function visibleToContext(record, context) {
  try {
    assertOwnedByContext(record, context);
    return true;
  } catch {
    return false;
  }
}

/** @param {AccountRole} role */
function roleProfile(role) {
  const mapping = {
    reviewer: "review",
    editor: "edit",
    operator: "agent",
    owner: "full",
  };
  return mapping[role];
}

/** @param {unknown} value @returns {value is AccountRole} */
function isAccountRole(value) {
  return value === "reviewer" || value === "editor" || value === "operator" || value === "owner";
}
const TOKEN_STOP_WORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "use", "using", "into", "of", "to", "a", "an", "in", "on", "is", "are", "or", "及", "和", "的", "了", "在", "用", "使用", "进行", "根据"]);

const GENERIC_IDENTITY_TOKENS = new Set(["app", "application", "cli", "local", "tool", "web"]);

const ENGLISH_TOKEN_CANONICAL = new Map([
  ["created", "create"], ["creating", "create"], ["creation", "create"], ["creator", "create"],
  ["improved", "improve"], ["improving", "improve"], ["improvement", "improve"],
  ["installed", "install"], ["installing", "install"], ["installation", "install"], ["installer", "install"],
  ["searched", "search"], ["searching", "search"], ["finder", "find"],
  ["documentation", "docs"], ["document", "docs"], ["documents", "docs"],
  ["validated", "verify"], ["validate", "verify"], ["validation", "verify"], ["verification", "verify"],
  ["factcheck", "verify"], ["fact-check", "verify"], ["testing", "test"], ["tests", "test"],
  ["building", "build"], ["built", "build"], ["deployment", "deploy"], ["deployed", "deploy"],
]);

/** @type {ReadonlyArray<readonly [RegExp, readonly string[]]>} */
const HAN_TOKEN_ALIASES = Object.freeze([
  [/创建|新建|编写/u, ["create", "creator"]],
  [/改进|优化|更新|维护/u, ["improve", "update"]],
  [/技能/u, ["skill"]],
  [/安装/u, ["install", "installer"]],
  [/部署/u, ["deploy", "deployment"]],
  [/查找|搜索|检索|调研|研究/u, ["search", "find", "research"]],
  [/最新|当前/u, ["latest", "current"]],
  [/官方/u, ["official"]],
  [/文档|资料/u, ["docs", "documentation"]],
  [/事实核查|核查|验证|校验/u, ["verify", "factcheck"]],
  [/测试/u, ["test"]],
  [/前端/u, ["frontend"]],
  [/设计/u, ["design"]],
  [/邮件|邮箱/u, ["email"]],
  [/浏览器|网页|网站/u, ["browser", "web"]],
  [/性能/u, ["performance"]],
  [/安全|漏洞/u, ["security", "audit"]],
]);

/**
 * @param {{name: string, description: string, argv: string[], searchTerms?: string}} command
 */
export function commandMatchText(command) {
  return `${command.name} ${command.description} ${command.argv.join(" ")} ${command.searchTerms || ""}`;
}

/** @param {unknown} task @param {unknown} candidate @param {unknown} [identity] */
export function relevanceScore(task, candidate, identity = "") {
  const taskTokens = tokenize(task);
  const candidateTokens = tokenize(candidate);
  if (!taskTokens.size || !candidateTokens.size) return 0;
  const identityTokens = tokenize(identity);
  let score = 0;
  for (const token of taskTokens) {
    if (candidateTokens.has(token)) score += token.length >= 6 ? 2 : 1;
    if (identityTokens.has(token) && !GENERIC_IDENTITY_TOKENS.has(token)) score += token.length >= 6 ? 4 : 3;
  }
  const taskComparable = comparableText(task);
  const candidateComparable = comparableText(candidate);
  const identityComparable = comparableText(identity);
  if (candidateComparable.includes(taskComparable) || taskComparable.includes(candidateComparable)) score += 4;
  if (identityComparable.length >= 3 && ` ${taskComparable} `.includes(` ${identityComparable} `)) score += 12;
  return score;
}

/**
 * @param {unknown} task
 * @param {{commandsAvailable: boolean, commandRelevant: boolean, skillRelevant: boolean}} options
 */
export function recommendTools(task, { commandsAvailable, commandRelevant, skillRelevant }) {
  const lower = String(task || "").toLowerCase();
  const tools = ["agent_context"];
  if (skillRelevant) tools.push("load_local_skill");
  if (commandRelevant) tools.push("run_local_command");
  if (/browser|chrome|edge|brave|网页|浏览器|表单|网站/.test(lower)) tools.push("computer_observe", "computer_act", "browser_status", "browser_list_tabs", "browser_manage_tabs", "browser_inspect_page", "browser_wait", "browser_action", "browser_fill_form");
  if (/app|application|gui|window|应用|软件|窗口|界面/.test(lower)) tools.push("computer_observe", "computer_act", "list_local_applications", "inspect_local_application", "operate_local_application");
  if (/git|commit|branch|diff|仓库|提交|分支/.test(lower)) tools.push("git_status", "git_diff");
  if (/commit|提交/.test(lower)) tools.push("git_commit");
  if (/test|build|lint|command|terminal|测试|构建|命令|终端/.test(lower)) tools.push(commandsAvailable ? "run_local_command" : "run_process");
  if (/file|code|source|edit|write|文件|代码|源码|修改|写入/.test(lower)) tools.push("read_file", "search_text", "edit_file", "apply_patch");
  return [...new Set(tools)];
}

/** @param {unknown} value @returns {Set<string>} */
export function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set();
  for (const raw of text.match(/[a-z0-9_][a-z0-9_.-]{1,}/g) || []) {
    const token = raw.replace(/^[.-]+|[.-]+$/g, "");
    addToken(tokens, token);
    for (const part of token.split(/[._-]+/)) addToken(tokens, part);
  }
  for (const sequence of text.match(/[\p{Script=Han}]{1,}/gu) || []) {
    addToken(tokens, sequence);
    const minimumSize = sequence.length === 1 ? 1 : 2;
    for (let size = minimumSize; size <= Math.min(3, sequence.length); size += 1) {
      for (let index = 0; index + size <= sequence.length; index += 1) addToken(tokens, sequence.slice(index, index + size));
    }
  }
  for (const [pattern, aliases] of HAN_TOKEN_ALIASES) {
    if (!pattern.test(text)) continue;
    for (const alias of aliases) addToken(tokens, alias);
  }
  return tokens;
}

/** @param {unknown} value */
function comparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** @param {Set<string>} tokens @param {unknown} raw */
function addToken(tokens, raw) {
  const token = String(raw || "").replace(/^[.-]+|[.-]+$/g, "");
  if (token.length < 2 || TOKEN_STOP_WORDS.has(token)) return;
  tokens.add(token);
  const canonical = ENGLISH_TOKEN_CANONICAL.get(token);
  if (canonical) tokens.add(canonical);
}
export const EXECUTION_SURFACE_ENV = "MBM_EXECUTION_SURFACE";

export const EXECUTION_SURFACE = Object.freeze({
  foregroundProcess: "foreground_process",
  processSession: "process_session",
  managedJob: "managed_job",
});

const KNOWN_SURFACES = /** @type {Set<string>} */ (new Set(Object.values(EXECUTION_SURFACE)));

/**
 * @param {Record<string, any>} environment
 * @param {string} surface
 * @returns {Record<string, any>}
 */
export function withExecutionSurface(environment, surface) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("execution surface requires an environment record");
  }
  if (!KNOWN_SURFACES.has(surface)) throw new TypeError("execution surface is invalid");
  return { ...environment, [EXECUTION_SURFACE_ENV]: surface };
}

/**
 * @param {Record<string, any>} [environment]
 * @returns {string}
 */
export function executionSurface(environment = process.env) {
  const value = String(environment?.[EXECUTION_SURFACE_ENV] || "");
  if (!value) return "";
  return KNOWN_SURFACES.has(value) ? value : "unknown";
}
const OWNER_ONLY_TOOLS = new Set((accessContract.ownerOnlyTools || []).map(String));

/** @typedef {{origin?: string, authority?: AuthorityContext, operationAuthorization?: OperationAuthorizationDecision}} AuthorizedOperationContext */
/** @typedef {{tool: string, args: Record<string, unknown>, context?: AuthorizedOperationContext}} AuthorizedOperation */
/** @typedef {{source: "local" | "trusted-owner" | "role-ceiling", category: string, scopes: string[], targetHash: string}} OperationAuthorizationBaseDecision */
/** @typedef {OperationAuthorizationBaseDecision & {allowed: boolean}} OperationAuthorizationDecision */
/** @typedef {{category?: string, scope?: string, scopes?: string[], targetHash?: string, canonicalTargets?: string[]}} OperationRequirement */
/** @typedef {{workspace: string, resolveExistingPath: (value: unknown, context?: AuthorizedOperationContext) => Promise<string>, resolveWritePath: (value: unknown, context?: AuthorizedOperationContext) => Promise<string>, protectedRoots: string[], auditTargetKey?: Uint8Array}} OperationAuthorizerOptions */

export class OperationAuthorizer {
  /** @param {OperationAuthorizerOptions} options */
  constructor(options) {
    this.workspace = path.resolve(options.workspace);
    this.resolveExistingPath = options.resolveExistingPath;
    this.resolveWritePath = options.resolveWritePath;
    this.protectedRoots = options.protectedRoots.filter(Boolean).map(canonicalProtectedRoot);
    this.auditTargetKey = Buffer.from(options.auditTargetKey || randomBytes(32));
  }

  /** @param {string} target */
  isProtectedPath(target) {
    const canonicalTarget = canonicalizePathForPolicy(target);
    return this.protectedRoots.some((root) => isWithinRoot(root, canonicalTarget));
  }

  /** @param {AuthorizedOperation} operation @returns {Promise<OperationAuthorizationDecision>} */
  async authorize(operation) {
    if (operation?.context?.origin !== "relay") {
      return /** @type {OperationAuthorizationDecision} */ ({ allowed: true, source: "local", category: "local operation", scopes: [], targetHash: "" });
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
    const operationContext = operation.context;
    /** @type {(value: unknown) => Promise<string>} */
    const resolveExistingPath = (value) => this.resolveExistingPath(value, operationContext);
    /** @type {(value: unknown) => Promise<string>} */
    const resolveWritePath = (value) => this.resolveWritePath(value, operationContext);
    /** @type {OperationRequirement | null} */
    const requirement = await classifyOperation(operation.tool, operation.args, {
      workspace: this.workspace,
      resolveExistingPath,
      resolveWritePath,
    });
    const decision = operationDecision(requirement, authority, this.auditTargetKey);
    operation.context.operationAuthorization = { ...decision, allowed: false };
    if (requirement && requirement.canonicalTargets?.some((target) => this.isProtectedPath(target))) {
      throw new BridgeError("authorization_denied", "Machine Bridge control-plane state cannot be accessed through generic path-based remote tools", {
        details: { reason: "control_plane_state_protected", tool: operation.tool },
      });
    }
    if (requirement) assertRequirementWithinAuthority(requirement, authority, operation.tool);
    return { ...decision, allowed: true };
  }
}

/** @param {OperationRequirement | null} requirement @param {AuthorityContext} authority @param {Uint8Array} auditTargetKey @returns {OperationAuthorizationBaseDecision} */
function operationDecision(requirement, authority, auditTargetKey) {
  return {
    source: authority.owner ? "trusted-owner" : "role-ceiling",
    category: requirement?.category || "ordinary operation",
    scopes: requirement ? normalizeScopes(requirement.scopes || [requirement.scope]) : [],
    targetHash: requirement ? auditTargetFingerprint(auditTargetKey, requirement.targetHash) : "",
  };
}

/** @param {Uint8Array} key @param {unknown} value */
function auditTargetFingerprint(key, value) {
  return createHmac("sha256", key).update(String(value || "")).digest("hex");
}

/** @param {unknown} scopes */
function normalizeScopes(scopes) {
  const requested = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || "")));
  return OPERATION_APPROVAL_SCOPES.filter((scope) => requested.has(scope));
}

/** @param {string} root @param {string} target */
function isWithinRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** @param {string} value */
function canonicalProtectedRoot(value) {
  return canonicalizePathForPolicy(value);
}

/** @param {string} value */
function canonicalizePathForPolicy(value) {
  let candidate = path.resolve(String(value));
  /** @type {string[]} */
  const suffix = [];
  while (true) {
    try {
      const canonical = realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
      return suffix.length ? path.resolve(canonical, ...suffix.reverse()) : canonical;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(String(value));
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/** @param {OperationRequirement} requirement @param {AuthorityContext} authority @param {string} tool */
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
