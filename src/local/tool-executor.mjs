import { performance } from "node:perf_hooks";
import catalog from "../shared/tool-catalog.json" with { type: "json" };
import { compileToolArgumentValidators } from "../shared/tool-argument-validation.mjs";
import { isRemoteDurableProcessTool, remoteDurableProcessTimeoutSeconds } from "../shared/foreground-timeout.mjs";
import { BridgeError, errorCode, normalizeBridgeError } from "./errors.mjs";
import { resourceAdmissionLogFields } from "./resource-admission-diagnostics.mjs";
import { normalizeToolResult } from "./tool-result-boundary.mjs";
import { createSecurityAuditFailureReporter } from "./security-audit-warning.mjs";
import { enqueueSecurityAudit } from "./security-audit-dispatch.mjs";

const TOOL_ARGUMENTS = compileToolArgumentValidators(catalog);

export function validateToolArguments(tool, value) {
  return TOOL_ARGUMENTS.validate(tool, value);
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
    this.safeMessage = typeof options.safeMessage === "function" ? options.safeMessage : (error) => String(error?.message || error || "operation failed");
    this.slowMs = Number.isFinite(Number(options.slowMs)) ? Math.max(1, Number(options.slowMs)) : 30_000;
    this.pipeline = composeMiddleware([
      lifecycleMiddleware(this.callRegistry),
      observabilityMiddleware(this.observability, this.securityAudit, this.logger, this.safeMessage, this.slowMs),
      authorizeMiddleware(this.policyGate, this.accountAccessGate, this.operationAuthorizer, this.callRegistry),
      validateArgumentsMiddleware(),
    ], invokeHandler(this.handlers));
  }

  execute(tool, args = {}, request = {}) {
    return this.pipeline({ tool: String(tool || ""), args, request });
  }
}

export function composeMiddleware(middleware, terminal) {
  return middleware.reduceRight((next, current) => (operation) => current(operation, next), terminal);
}

function authorizeMiddleware(policyGate, accountAccessGate, operationAuthorizer, callRegistry) {
  return async (operation, next) => {
    policyGate.assert(operation.tool);
    if (operation.context.origin === "relay") {
      const authorization = operation.request.authorization;
      const role = authorization?.role;
      if (!role) throw new Error("relay tool call is missing an account role");
      accountAccessGate.assert(role, operation.tool);
      operation.context.authority = accountAccessGate.authority(authorization, policyGate.policy, "relay");
      callRegistry.bindPrincipal(operation.context.callId, operation.context.authority.principal);
      const decision = await operationAuthorizer?.authorize(operation);
      if (decision) operation.context.operationAuthorization = decision;
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
    if (!result.valid && !validRelayDurableProcessSchemaExtension(operation, result.issues)) {
      throw new BridgeError("invalid_request", `tool arguments do not match the input schema: ${operation.tool}`, {
        details: { tool: operation.tool, validation_issues: result.issues },
      });
    }
    return next(operation);
  };
}

function validRelayDurableProcessSchemaExtension(operation, issues) {
  if (operation.context.origin !== "relay" || !isRemoteDurableProcessTool(operation.tool) || !Array.isArray(issues) || !issues.length) {
    return false;
  }
  if (issues.some((issue) => issue?.instancePath !== "/timeout_seconds" || issue?.keyword !== "maximum")) return false;
  try {
    remoteDurableProcessTimeoutSeconds(operation.args?.timeout_seconds);
    return true;
  } catch {
    return false;
  }
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
      observability.finish(operation.tool, { status: "completed", durationMs, slow });
      enqueueSecurityAudit(securityAudit, operation, { outcome: "completed", durationMs, outputBytes: normalizedResult.bytes }, auditFailureReporter);
      logger.event?.("debug", slow ? "tool.call.slow" : "tool.call.completed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin, duration_ms: durationMs,
        authority_role: operation.context.authority?.principal?.role || "local",
        risk_category: operation.context.operationAuthorization?.category || "ordinary",
      }, slow ? "Tool call completed slowly" : "Tool call completed");
      return result;
    } catch (error) {
      const normalized = normalizeBridgeError(error, { safeMessage: () => safeMessage(error, operation.args, operation.context) });
      const durationMs = performance.now() - started;
      const code = errorCode(normalized);
      const status = code === "cancelled" ? "cancelled" : code === "timeout" ? "timeout" : "failed";
      observability.finish(operation.tool, { status, durationMs, errorCode: code, slow: durationMs >= slowMs });
      enqueueSecurityAudit(securityAudit, operation, { outcome: status, durationMs, errorCode: code }, auditFailureReporter);
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

function invokeHandler(handlers) {
  return async (operation) => {
    const handler = handlers[operation.tool];
    if (typeof handler !== "function") throw new Error(`runtime handler is missing for tool: ${operation.tool}`);
    return handler(operation.args, operation.context);
  };
}


function shortCallId(value) {
  return String(value || "").slice(0, 20);
}
