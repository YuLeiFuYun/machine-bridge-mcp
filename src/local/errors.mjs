const ERROR_CODES = new Set([
  "cancelled", "timeout", "authentication_failed", "authorization_denied", "policy_denied",
  "invalid_request", "not_found", "conflict", "limit_exceeded", "permission_denied",
  "path_boundary", "network_error", "protocol_error", "unavailable", "integrity_error",
  "execution_failed", "internal_error",
]);

const RETRYABLE_CODES = new Set(["timeout", "network_error", "unavailable"]);

export class BridgeError extends Error {
  constructor(code, message, options = {}) {
    const normalizedCode = normalizeErrorCode(code);
    super(String(message || defaultMessage(normalizedCode)), options.cause ? { cause: options.cause } : undefined);
    this.name = "BridgeError";
    this.code = normalizedCode;
    this.retryable = options.retryable === undefined ? RETRYABLE_CODES.has(normalizedCode) : options.retryable === true;
    this.expose = options.expose !== false;
    this.details = isRecord(options.details) ? Object.freeze({ ...options.details }) : undefined;
  }
}

export function bridgeError(code, message, options) {
  return new BridgeError(code, message, options);
}

export function normalizeBridgeError(error, options = {}) {
  if (error instanceof BridgeError) return error;
  const code = errorCode(error, options.defaultCode);
  const message = typeof options.safeMessage === "function"
    ? options.safeMessage(error)
    : typeof options.safeMessage === "string"
      ? options.safeMessage
      : safeFallbackMessage(error, code);
  return new BridgeError(code, message, {
    cause: error instanceof Error ? error : undefined,
    expose: options.expose !== false,
    retryable: options.retryable,
  });
}

export function errorCode(error, fallback = "execution_failed") {
  if (error instanceof BridgeError) return error.code;
  const direct = normalizeErrorCode(error?.code, "");
  if (direct && ERROR_CODES.has(direct)) return direct;
  const nodeCode = String(error?.code || "").toUpperCase();
  if (["ENOENT", "ENOTDIR"].includes(nodeCode)) return "not_found";
  if (["EACCES", "EPERM", "EROFS"].includes(nodeCode)) return "permission_denied";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(nodeCode)) return "timeout";
  if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(nodeCode)) return "network_error";
  if (["EEXIST", "ENOTEMPTY", "EBUSY"].includes(nodeCode)) return "conflict";

  return normalizeErrorCode(fallback);
}

export function publicError(error, options = {}) {
  const normalized = normalizeBridgeError(error, options);
  return {
    code: normalized.code,
    message: normalized.expose ? normalized.message : defaultMessage(normalized.code),
    retryable: normalized.retryable,
  };
}

export function remoteBridgeError(value, fallbackMessage = "remote operation failed") {
  if (isRecord(value)) {
    const code = normalizeErrorCode(value.code);
    const message = typeof value.message === "string" && value.message ? value.message : fallbackMessage;
    return new BridgeError(code, message, { retryable: value.retryable === true });
  }
  return new BridgeError("execution_failed", fallbackMessage);
}

export function normalizeErrorCode(value, fallback = "execution_failed") {
  const code = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return ERROR_CODES.has(code) ? code : fallback;
}

function safeFallbackMessage(error, code) {
  if (error instanceof Error && error.message) return String(error.message).slice(0, 2000);
  return defaultMessage(code);
}

function defaultMessage(code) {
  const messages = {
    cancelled: "operation cancelled",
    timeout: "operation timed out",
    authentication_failed: "authentication failed",
    authorization_denied: "authorization denied",
    policy_denied: "operation denied by policy",
    invalid_request: "invalid request",
    not_found: "requested resource was not found",
    conflict: "operation conflicts with current state",
    limit_exceeded: "operation exceeded a configured limit",
    permission_denied: "permission denied",
    path_boundary: "path is outside the configured boundary",
    network_error: "network operation failed",
    protocol_error: "protocol error",
    unavailable: "service is unavailable",
    integrity_error: "integrity check failed",
    internal_error: "internal error",
    execution_failed: "operation failed",
  };
  return messages[code] || messages.execution_failed;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
