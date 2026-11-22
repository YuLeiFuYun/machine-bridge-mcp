import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import catalog from "../../shared/tool-catalog.json" with { type: "json" };
import { compileToolArgumentValidators } from "../../shared/tool-argument-validation.mjs";
import { validRelayToolSchemaExtension } from "../transport/relay-recovery.mjs";
import { BridgeError, errorCode, normalizeBridgeError } from "../core/errors.mjs";
import { classifyReversibility, operationMayHaveSideEffects } from "../core/operation-risk.mjs";
import { resourceAdmissionLogFields } from "../process/resource-admission-policy.mjs";
import { normalizeToolResult } from "./call-registry.mjs";
import { createSecurityAuditFailureReporter } from "./runtime-projections.mjs";
import { enqueueSecurityAudit, securityAuditPreDispatchMiddleware } from "./security-audit-log.mjs";
import { shortCallId } from "../../shared/records.mjs";

const TOOL_ARGUMENTS = compileToolArgumentValidators(catalog);

export function validateToolArguments(tool, value) {
  return TOOL_ARGUMENTS.validate(tool, value);
}

function reflexionGuidance(tool) {
  if (tool === "edit_file" || tool === "apply_patch") {
    return ". Reflexion: Re-read the file with with_line_numbers: true to verify exact target content and indentation.";
  }
  if (tool.startsWith("browser_") || tool.startsWith("computer_")) {
    return ". Reflexion: Capture fresh state with browser_inspect_page or computer_observe to verify DOM/visual alignment.";
  }
  if (tool.startsWith("git_")) {
    return ". Reflexion: Run git_status or git_diff to diagnose repository state before retrying.";
  }
  return "";
}

// Only failures that a different argument or a fresh observation can plausibly fix belong in
// the loop detector. Authorization, schema, and missing-target errors are deterministic: counting
// them would both mislabel the failure and disclose guidance for tools the caller cannot use.
const LOOP_TRACKED_ERROR_CODES = new Set([
  "execution_failed", "timeout", "network_error", "unavailable", "conflict", "limit_exceeded", "internal_error",
]);

const UNTRUSTED_CONTENT_TOOLS = new Set([
  "browser_get_source", "browser_inspect_page", "browser_network_log", "browser_screenshot",
]);

const MAX_TRACKED_PRINCIPALS = 64;

const TAINT_TTL_MS = 30 * 60 * 1000;

function isUntrustedContentRead(tool, args) {
  if (UNTRUSTED_CONTENT_TOOLS.has(tool)) return true;
  return tool === "computer_observe" && args?.surface === "browser";
}

function stableJsonForDigest(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === "bigint") return String(value);
  if (kind !== "object") return value;
  if (depth > 24) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item) => stableJsonForDigest(item, seen, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "snapshot_id" || key === "captured_at" || key === "observed_at" || key === "timestamp") continue;
      const entry = value[key];
      if ((key === "data" || key === "set_of_marks_svg") && typeof entry === "string" && entry.length > 256) {
        out[key] = `[len:${entry.length}]`;
      } else {
        out[key] = stableJsonForDigest(entry, seen, depth + 1);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function computeResultDigest(tool, result) {
  if (operationMayHaveSideEffects(tool) && tool !== "computer_observe") return "";
  try {
    const normalized = stableJsonForDigest(result ?? null);
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function principalKey(authority) {
  const principal = authority?.principal;
  if (!principal || principal.kind !== "account") return "local";
  return [
    "account",
    String(principal.accountId || ""),
    String(principal.accountVersion ?? ""),
    String(principal.clientId || ""),
    String(principal.familyId || ""),
  ].join(":");
}

export class StuckLoopDetector {
  constructor(threshold = 3) {
    this.threshold = typeof threshold === "number" && Number.isSafeInteger(threshold) ? Math.max(2, threshold) : 3;
    this.recentCalls = [];
    this.unserializableSeq = 0;
  }

  argDigestKey(tool, args) {
    try {
      const normalized = stableJsonForDigest(args && typeof args === "object" ? args : {});
      const encoded = JSON.stringify(normalized);
      const hash = createHash("sha256").update(encoded).digest("hex").slice(0, 24);
      return `${tool}:${hash}`;
    } catch {
      this.unserializableSeq += 1;
      return `${tool}:unserializable:${this.unserializableSeq}`;
    }
  }

  record(tool, args, status, meta = {}) {
    const key = this.argDigestKey(tool, args);
    const errorCode = typeof meta?.errorCode === "string" ? meta.errorCode : "";
    const resultDigest = typeof meta?.resultDigest === "string" ? meta.resultDigest : "";
    this.recentCalls.push({ tool: String(tool || ""), key, status, errorCode, resultDigest });
    const maxHistory = Math.max(20, this.threshold * 4);
    if (this.recentCalls.length > maxHistory) this.recentCalls.shift();

    if (status === "failed") {
      const tail = this.recentCalls.slice(-this.threshold);
      if (tail.length === this.threshold && tail.every((item) => item.key === key && item.status === "failed")) {
        return {
          detected: true,
          pattern: "identical_repeat",
          consecutiveCount: this.threshold,
          warning: `stuck_loop_warning: ${this.threshold} consecutive identical calls to '${tool}' failed; consider changing arguments or trying an alternative strategy${reflexionGuidance(tool)}`,
        };
      }
      if (errorCode && tail.length === this.threshold && tail.every((item) => item.status === "failed" && item.errorCode === errorCode)) {
        return {
          detected: true,
          pattern: "repeated_error_class",
          errorCode,
          consecutiveCount: this.threshold,
          warning: `stuck_loop_warning: ${this.threshold} consecutive failures with error class '${errorCode}'${reflexionGuidance(tool)}`,
        };
      }
    }

    if (this.recentCalls.length >= 4) {
      const a = this.recentCalls.at(-4);
      const b = this.recentCalls.at(-3);
      const c = this.recentCalls.at(-2);
      const d = this.recentCalls.at(-1);
      const oscillatingFailure = a.status === "failed" || b.status === "failed" || c.status === "failed" || d.status === "failed";
      const oscillatingStall = Boolean(a.resultDigest && a.resultDigest === c.resultDigest && b.resultDigest && b.resultDigest === d.resultDigest);
      if (a && b && c && d && a.key === c.key && b.key === d.key && a.key !== b.key && (oscillatingFailure || oscillatingStall)) {
        return {
          detected: true,
          pattern: "oscillation",
          consecutiveCount: 4,
          warning: `stuck_loop_warning: 2-step oscillation detected between '${a.tool}' and '${b.tool}'; change strategy instead of repeating the cycle${reflexionGuidance(tool)}`,
        };
      }
    }

    if (status === "completed" && resultDigest && this.recentCalls.length >= this.threshold) {
      const tail = this.recentCalls.slice(-this.threshold);
      if (tail.every((item) => item.tool === tool && item.status === "completed" && item.resultDigest === resultDigest)) {
        return {
          detected: true,
          pattern: "stalled_observation",
          consecutiveCount: this.threshold,
          warning: `stuck_loop_warning: ${this.threshold} consecutive '${tool}' observations returned identical output; inspect downstream state before retrying`,
        };
      }
    }
    return null;
  }
}

export class ToolExecutor {
  constructor(options = {}) {
    this.handlers = options.handlers || {};
    this.policyGate = options.policyGate;
    this.callRegistry = options.callRegistry;
    this.accountAccessGate = options.accountAccessGate;
    this.operationAuthorizer = options.operationAuthorizer;
    this.observability = options.observability;
    this.securityAudit = options.securityAudit || null;
    this.logger = options.logger || console;
    this.onAuthorizedRelayActivityStart = typeof options.onAuthorizedRelayActivityStart === "function" ? options.onAuthorizedRelayActivityStart : null;
    this.onAuthorizedRelayActivityEnd = typeof options.onAuthorizedRelayActivityEnd === "function" ? options.onAuthorizedRelayActivityEnd : null;
    this.safeMessage = typeof options.safeMessage === "function" ? options.safeMessage : (error) => String(error?.message || error || "operation failed");
    this.slowMs = Number.isFinite(Number(options.slowMs)) ? Math.max(1, Number(options.slowMs)) : 30_000;
    this.taintStates = new Map();
    this.loopDetectors = new Map();
    this.pipeline = composeMiddleware([
      lifecycleMiddleware(this.callRegistry),
      observabilityMiddleware(
        this.observability,
        this.securityAudit,
        this.logger,
        this.safeMessage,
        this.slowMs,
      ),
      authorityMiddleware(this.policyGate, this.accountAccessGate, this.callRegistry),
      validateArgumentsMiddleware(),
      operationAuthorizationMiddleware(this.operationAuthorizer),
      executionGuardrailsMiddleware(this.taintStates, this.loopDetectors, this.observability, this.logger, this.safeMessage),
      securityAuditPreDispatchMiddleware(this.securityAudit),
    ], invokeHandler(this.handlers, this.onAuthorizedRelayActivityStart, this.onAuthorizedRelayActivityEnd));
  }

  taintSnapshot(key = null) {
    const now = performance.now();
    for (const [entryKey, state] of this.taintStates.entries()) {
      if (state.expiresAt <= now) this.taintStates.delete(entryKey);
    }
    if (key !== null) {
      const state = this.taintStates.get(key);
      return state
        ? { untrusted_content_seen: state.untrusted_content_seen, sources: [...state.sources], advisory_count: state.advisory_count }
        : { untrusted_content_seen: false, sources: [], advisory_count: 0 };
    }
    const sources = new Set();
    let advisoryCount = 0;
    let seen = false;
    for (const state of this.taintStates.values()) {
      if (state.untrusted_content_seen) seen = true;
      advisoryCount += state.advisory_count;
      for (const src of state.sources) sources.add(src);
    }
    return { untrusted_content_seen: seen, sources: [...sources], advisory_count: advisoryCount };
  }

  execute(tool, args = {}, request = {}) {
    return this.pipeline({ tool: String(tool || ""), args, request });
  }
}

export function composeMiddleware(middleware, terminal) {
  return middleware.reduceRight((next, current) => (operation) => current(operation, next), terminal);
}

function authorityMiddleware(policyGate, accountAccessGate, callRegistry) {
  return async (operation, next) => {
    policyGate.assert(operation.tool);
    if (operation.context.origin === "relay") {
      const authorization = operation.request.authorization;
      const role = authorization?.role;
      if (!role) throw new Error("relay tool call is missing an account role");
      accountAccessGate.assert(role, operation.tool);
      operation.context.authority = accountAccessGate.authority(authorization, policyGate.policy, "relay");
      callRegistry.bindPrincipal(operation.context.callId, operation.context.authority.principal);
    } else {
      operation.context.authority = accountAccessGate.authority({}, policyGate.policy, "local");
      callRegistry.bindPrincipal(operation.context.callId, operation.context.authority.principal);
    }
    return next(operation);
  };
}

function validateArgumentsMiddleware() {
  return async (operation, next) => {
    const result = TOOL_ARGUMENTS.validate(operation.tool, operation.args);
    if (!result.known) throw new BridgeError("not_found", `unknown tool: ${operation.tool}`);
    if (!result.valid && !validRelayToolSchemaExtension(operation, result.issues)) {
      throw new BridgeError("invalid_request", `tool arguments do not match the input schema: ${operation.tool}`, {
        details: { tool: operation.tool, validation_issues: result.issues },
      });
    }
    return next(operation);
  };
}

function operationAuthorizationMiddleware(operationAuthorizer) {
  return async (operation, next) => {
    if (operation.context.origin === "relay") {
      const decision = await operationAuthorizer?.authorize(operation);
      if (decision) operation.context.operationAuthorization = decision;
    }
    return next(operation);
  };
}

function lifecycleMiddleware(callRegistry) {
  return async (operation, next) => {
    const context = callRegistry.open({
      callId: operation.request.callId,
      tool: operation.tool,
      origin: operation.request.origin || "local",
      timeoutMs: operation.request.timeoutMs,
    });
    operation.context = { ...operation.request.context, ...context };
    try {
      callRegistry.throwIfCancelled(operation.context);
      // Handler return is the local settlement point. Cooperative handlers observe cancellation
      // before or during cancellable work; a later signal must not retroactively relabel a
      // completed side effect as cancelled after observability/audit already recorded completion.
      return await next(operation);
    } finally {
      callRegistry.finish(context.callId);
    }
  };
}

function boundedMapEntry(map, key, factory) {
  let entry = map.get(key);
  if (entry) return entry;
  if (map.size >= MAX_TRACKED_PRINCIPALS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  entry = factory();
  map.set(key, entry);
  return entry;
}

function principalTaintState(taintStates, key) {
  const now = performance.now();
  const existing = taintStates.get(key);
  if (existing && existing.expiresAt <= now) taintStates.delete(key);
  return boundedMapEntry(taintStates, key, () => ({
    untrusted_content_seen: false,
    sources: new Set(),
    advisory_count: 0,
    expiresAt: now + TAINT_TTL_MS,
  }));
}

function executionGuardrailsMiddleware(taintStates, loopDetectors, observability, logger, safeMessage) {
  return async (operation, next) => {
    const key = principalKey(operation.context.authority);
    const taint = principalTaintState(taintStates, key);
    const detector = boundedMapEntry(loopDetectors, key, () => new StuckLoopDetector(3));
    if (taint.untrusted_content_seen && classifyReversibility(operation.tool, operation.args) === "irreversible") {
      taint.advisory_count += 1;
      taint.expiresAt = performance.now() + TAINT_TTL_MS;
      observability.recordTaintAdvisory?.({ tool: operation.tool, sources: [...taint.sources] });
      logger.event?.("debug", "tool.call.taint_advisory", {
        call_id: shortCallId(operation.context.callId),
        tool: operation.tool,
        sources: [...taint.sources],
      }, "Irreversible tool executed after untrusted content read");
    }
    try {
      const result = await next(operation);
      if (isUntrustedContentRead(operation.tool, operation.args)) {
        taint.untrusted_content_seen = true;
        taint.sources.add(operation.tool);
        taint.expiresAt = performance.now() + TAINT_TTL_MS;
      }
      const resultDigest = computeResultDigest(operation.tool, result);
      const loopNotice = detector.record(operation.tool, operation.args, "completed", { resultDigest });
      if (loopNotice?.detected) {
        logger.event?.("debug", "tool.call.stuck_loop", {
          call_id: shortCallId(operation.context.callId),
          tool: operation.tool,
          pattern: loopNotice.pattern,
        }, loopNotice.warning);
      }
      return result;
    } catch (error) {
      const normalized = normalizeBridgeError(error, { safeMessage: () => safeMessage(error, operation.args, operation.context) });
      const code = errorCode(normalized);
      const loopWarning = LOOP_TRACKED_ERROR_CODES.has(code)
        ? detector.record(operation.tool, operation.args, "failed", { errorCode: code })
        : null;
      if (loopWarning?.detected) {
        normalized.details = {
          ...normalized.details,
          stuck_loop_warning: loopWarning.warning,
          stuck_loop_pattern: loopWarning.pattern,
        };
        throw normalized;
      }
      throw error;
    }
  };
}

function observabilityMiddleware(observability, securityAudit, logger, safeMessage, slowMs) {
  const auditFailureReporter = createSecurityAuditFailureReporter(logger);
  return async (operation, next) => {
    const started = performance.now();
    observability.start(operation.tool);
    logger.event?.("debug", "tool.call.started", {
      call_id: shortCallId(operation.context.callId),
      tool: operation.tool,
      origin: operation.context.origin,
    }, "Tool call started");
    try {
      const normalizedResult = normalizeToolResult(await next(operation));
      const result = normalizedResult.value;
      const durationMs = performance.now() - started;
      const slow = durationMs >= slowMs;
      observability.finish(operation.tool, { status: "completed", durationMs, slow, resultBytes: normalizedResult.bytes });
      enqueueSecurityAudit(securityAudit, operation, { outcome: "completed", durationMs, outputBytes: normalizedResult.bytes }, auditFailureReporter);
      logger.event?.("debug", slow ? "tool.call.slow" : "tool.call.completed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin, duration_ms: durationMs,
        authority_role: operation.context.authority?.principal?.role || "local",
        risk_category: operation.context.operationAuthorization?.category || "ordinary",
      }, slow ? "Tool call completed slowly" : "Tool call completed");
      return result;
    } catch (error) {
      const normalized = normalizeBridgeError(error, { safeMessage: () => safeMessage(error, operation.args, operation.context) });
      const code = errorCode(normalized);
      const durationMs = performance.now() - started;
      const status = code === "cancelled" ? "cancelled" : code === "timeout" ? "timeout" : "failed";
      observability.finish(operation.tool, { status, durationMs, errorCode: code, slow: durationMs >= slowMs });
      enqueueSecurityAudit(securityAudit, operation, {
        outcome: status, durationMs, errorCode: code,
        requestDelivery: normalized.details?.request_delivery,
        sideEffectsStarted: normalized.details?.side_effects_started,
        effectSettlement: normalized.details?.effect_settlement,
        terminationRequested: normalized.details?.termination_requested,
      }, auditFailureReporter);
      const resourceAdmission = resourceAdmissionLogFields(normalized);
      logger.event?.("debug", "tool.call.failed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin,
        duration_ms: durationMs, error_code: code, retryable: normalized.retryable,
        authority_role: operation.context.authority?.principal?.role || "local",
        risk_category: operation.context.operationAuthorization?.category || "ordinary",
        ...resourceAdmission,
      }, "Tool call failed");
      throw normalized;
    }
  };
}

function invokeHandler(handlers, onAuthorizedRelayActivityStart, onAuthorizedRelayActivityEnd) {
  return async (operation) => {
    const handler = Object.hasOwn(handlers, operation.tool) ? handlers[operation.tool] : undefined;
    if (typeof handler !== "function") throw new Error(`runtime handler is missing for tool: ${operation.tool}`);
    const relayActivity = operation.context.origin === "relay";
    if (relayActivity) bestEffortActivityHook(onAuthorizedRelayActivityStart);
    try { return await handler(operation.args, operation.context); }
    finally { if (relayActivity) bestEffortActivityHook(onAuthorizedRelayActivityEnd); }
  };
}

function bestEffortActivityHook(callback) {
  try { callback?.(); } catch { /* Auxiliary power-management hooks must not change tool settlement. */ }
}
