import { performance } from "node:perf_hooks";
import { errorCode, normalizeBridgeError } from "./errors.mjs";
import { normalizeToolResult } from "./tool-result-boundary.mjs";

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
      authorizeMiddleware(this.policyGate, this.accountAccessGate, this.operationAuthorizer),
    ], invokeHandler(this.handlers));
  }

  execute(tool, args = {}, request = {}) {
    return this.pipeline({ tool: String(tool || ""), args: isRecord(args) ? args : {}, request });
  }
}

export function composeMiddleware(middleware, terminal) {
  return middleware.reduceRight((next, current) => (operation) => current(operation, next), terminal);
}

function authorizeMiddleware(policyGate, accountAccessGate, operationAuthorizer) {
  return async (operation, next) => {
    policyGate.assert(operation.tool);
    if (operation.context.origin === "relay") {
      const authorization = operation.request.authorization;
      const role = authorization?.role;
      if (!role) throw new Error("relay tool call is missing an account role");
      accountAccessGate.assert(role, operation.tool);
      operation.context.authority = accountAccessGate.authority(authorization, policyGate.policy, "relay");
      const decision = await operationAuthorizer?.authorize(operation);
      if (decision) operation.context.operationAuthorization = decision;
    } else {
      operation.context.authority = accountAccessGate.authority({}, policyGate.policy, "local");
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
      const result = await next(operation);
      callRegistry.throwIfCancelled(operation.context);
      return result;
    } finally {
      callRegistry.finish(context.callId);
    }
  };
}

function observabilityMiddleware(observability, securityAudit, logger, safeMessage, slowMs) {
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
      await recordSecurityAudit(securityAudit, operation, { outcome: "completed", durationMs, outputBytes: normalizedResult.bytes });
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
      await recordSecurityAudit(securityAudit, operation, { outcome: status, durationMs, errorCode: code });
      logger.event?.("debug", "tool.call.failed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin,
        duration_ms: durationMs, error_code: code, retryable: normalized.retryable,
        authority_role: operation.context.authority?.principal?.role || "local",
        risk_category: operation.context.operationAuthorization?.category || "ordinary",
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


async function recordSecurityAudit(securityAudit, operation, outcome) {
  if (!securityAudit?.record || operation.context.origin !== "relay") return;
  const decision = operation.context.operationAuthorization || {};
  const recorded = await securityAudit.record({
    ...outcome,
    tool: operation.tool,
    riskCategory: decision.category || "ordinary operation",
    targetHash: decision.targetHash || "",
    principal: operation.context.authority?.principal || {},
    inputBytes: safeByteLength(operation.args),
  });
  if (!recorded) operation.context.auditWarning = "security_audit_unavailable";
}

function safeByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function shortCallId(value) {
  return String(value || "").slice(0, 20);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
