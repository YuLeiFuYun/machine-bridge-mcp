import { errorCode, normalizeBridgeError } from "./errors.mjs";

export class ToolExecutor {
  constructor(options = {}) {
    this.handlers = options.handlers || {};
    this.policyGate = options.policyGate;
    this.callRegistry = options.callRegistry;
    this.observability = options.observability;
    this.logger = options.logger || console;
    this.safeMessage = typeof options.safeMessage === "function" ? options.safeMessage : (error) => String(error?.message || error || "operation failed");
    this.slowMs = Number.isFinite(Number(options.slowMs)) ? Math.max(1, Number(options.slowMs)) : 30_000;
    this.pipeline = composeMiddleware([
      lifecycleMiddleware(this.callRegistry),
      observabilityMiddleware(this.observability, this.logger, this.safeMessage, this.slowMs),
      authorizeMiddleware(this.policyGate),
    ], invokeHandler(this.handlers));
  }

  execute(tool, args = {}, request = {}) {
    return this.pipeline({ tool: String(tool || ""), args: isRecord(args) ? args : {}, request });
  }
}

export function composeMiddleware(middleware, terminal) {
  return middleware.reduceRight((next, current) => (operation) => current(operation, next), terminal);
}

function authorizeMiddleware(policyGate) {
  return async (operation, next) => {
    policyGate.assert(operation.tool);
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

function observabilityMiddleware(observability, logger, safeMessage, slowMs) {
  return async (operation, next) => {
    const started = Date.now();
    observability.start(operation.tool);
    logger.event?.("debug", "tool.call.started", {
      call_id: shortCallId(operation.context.callId),
      tool: operation.tool,
      origin: operation.context.origin,
    });
    try {
      const result = await next(operation);
      const durationMs = Date.now() - started;
      const slow = durationMs >= slowMs;
      observability.finish(operation.tool, { status: "completed", durationMs, slow });
      logger.event?.("debug", slow ? "tool.call.slow" : "tool.call.completed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin, duration_ms: durationMs,
      });
      return result;
    } catch (error) {
      const normalized = normalizeBridgeError(error, { safeMessage: () => safeMessage(error, operation.args) });
      const durationMs = Date.now() - started;
      const code = errorCode(normalized);
      const status = code === "cancelled" ? "cancelled" : code === "timeout" ? "timeout" : "failed";
      observability.finish(operation.tool, { status, durationMs, errorCode: code, slow: durationMs >= slowMs });
      logger.event?.("debug", "tool.call.failed", {
        call_id: shortCallId(operation.context.callId), tool: operation.tool, origin: operation.context.origin,
        duration_ms: durationMs, error_code: code, retryable: normalized.retryable,
      });
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
