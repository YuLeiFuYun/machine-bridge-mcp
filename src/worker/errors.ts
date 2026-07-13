const WORKER_ERROR_CODES = new Set([
  "cancelled", "timeout", "authentication_failed", "authorization_denied", "policy_denied",
  "invalid_request", "not_found", "conflict", "limit_exceeded", "permission_denied",
  "path_boundary", "network_error", "protocol_error", "unavailable", "integrity_error",
  "execution_failed", "internal_error",
]);

export class WorkerToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "WorkerToolError";
    this.code = normalizeCode(code);
    this.retryable = retryable;
  }
}

export function daemonToolError(value: unknown): WorkerToolError {
  const input = asObject(value);
  const code = normalizeCode(input.code);
  const message = typeof input.message === "string" && input.message
    ? input.message.slice(0, 2000)
    : "daemon tool failed";
  return new WorkerToolError(code, message, input.retryable === true);
}

export function publicWorkerToolError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof WorkerToolError) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "execution_failed", message: "tool execution failed", retryable: false };
}

function normalizeCode(value: unknown): string {
  const code = String(value || "execution_failed").toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return WORKER_ERROR_CODES.has(code) ? code : "execution_failed";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
