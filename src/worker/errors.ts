import { settlementGuidance } from "../shared/error-guidance.mjs";

const WORKER_ERROR_CODES = new Set([
  "cancelled", "timeout", "authentication_failed", "authorization_denied", "policy_denied",
  "invalid_request", "not_found", "conflict", "limit_exceeded", "permission_denied",
  "path_boundary", "network_error", "protocol_error", "unavailable", "integrity_error",
  "execution_failed", "internal_error",
]);

export class WorkerToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkerToolError";
    this.code = normalizeCode(code);
    this.retryable = retryable;
    this.details = details;
  }
}

export function daemonToolError(value: unknown): WorkerToolError {
  const input = asObject(value);
  const code = normalizeCode(input.code);
  const message = typeof input.message === "string" && input.message
    ? input.message.slice(0, 2000)
    : "daemon tool failed";
  const details = isRecord(input.details) ? { ...input.details } : {};
  if (typeof input.actionable_remedy === "string" && !details.actionable_remedy) {
    details.actionable_remedy = input.actionable_remedy;
  }
  return new WorkerToolError(
    code, message, input.retryable === true,
    Object.keys(details).length ? details : undefined,
  );
}

export function dispatchedDaemonTimeoutError(tool: string, terminationRequested = true, recovery?: Record<string, unknown>): WorkerToolError {
  return dispatchedDaemonCancellationStateError("timeout", `daemon tool timed out: ${tool}`, terminationRequested, recovery);
}

export function dispatchedDaemonCancellationError(message: string, terminationRequested = true, recovery?: Record<string, unknown>): WorkerToolError {
  return dispatchedDaemonCancellationStateError("cancelled", message, terminationRequested, recovery);
}

function dispatchedDaemonCancellationStateError(code: "cancelled" | "timeout", message: string, terminationRequested: boolean, recovery?: Record<string, unknown>): WorkerToolError {
  return new WorkerToolError(
    code,
    message,
    false,
    {
      side_effects_started: true,
      termination_requested: terminationRequested,
      effect_settlement: terminationRequested ? "pending" : "unknown",
      ...(recovery ? { recovery } : {}),
    },
  );
}

export function dispatchedDaemonDisconnectError(message: string, recovery?: Record<string, unknown>, reason?: string): WorkerToolError {
  const readOnlyRecovery = recovery?.mode === "read_same_job";
  const retryable = readOnlyRecovery || recovery?.mode === "idempotent_replay";
  return new WorkerToolError(
    "unavailable",
    message,
    retryable,
    {
      side_effects_started: !readOnlyRecovery,
      ...(!readOnlyRecovery ? { termination_requested: false, effect_settlement: "unknown" } : {}),
      ...(reason ? { reason } : {}),
      ...(recovery ? { recovery } : {}),
    },
  );
}

export function dispatchedDaemonPlannedDrainError(recovery?: Record<string, unknown>): WorkerToolError {
  return dispatchedDaemonDisconnectError(
    "local daemon is performing a planned restart; recover the same operation after reconnect",
    recovery,
    "daemon_planned_drain",
  );
}

export function daemonCallNotReceivedAfterReconnectError(recovery?: Record<string, unknown>): WorkerToolError {
  return new WorkerToolError(
    "unavailable",
    "daemon reconnect confirmed the tool call was not received; retry the call",
    true,
    {
      side_effects_started: false,
      reason: "daemon_call_not_received_after_reconnect",
      ...(recovery ? { recovery } : {}),
    },
  );
}

export function revokedDaemonAuthorityError(): WorkerToolError {
  return new WorkerToolError("authorization_denied", "tool call authority was revoked", false, {
    side_effects_started: true,
    termination_requested: false,
    effect_settlement: "unknown",
  });
}

export function publicWorkerToolError(error: unknown): { code: string; message: string; retryable: boolean; actionable_remedy?: string; details?: Record<string, unknown> } {
  if (error instanceof WorkerToolError) {
    const remedy = settlementGuidance(error)
      || (typeof error.details?.actionable_remedy === "string" ? error.details.actionable_remedy : null);
    let details: Record<string, unknown> | undefined = error.details ? { ...error.details } : undefined;
    if (details && "actionable_remedy" in details) {
      delete details.actionable_remedy;
      if (Object.keys(details).length === 0) details = undefined;
    }
    return {
      code: error.code, message: error.message, retryable: error.retryable,
      ...(remedy ? { actionable_remedy: remedy } : {}),
      ...(details ? { details } : {}),
    };
  }
  return { code: "execution_failed", message: "tool execution failed", retryable: false };
}

function normalizeCode(value: unknown): string {
  const code = String(value || "execution_failed").toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return WORKER_ERROR_CODES.has(code) ? code : "execution_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
