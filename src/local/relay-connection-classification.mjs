const MAX_PROTOCOL_ERROR_CODE_CHARS = 64;

export function relayServerErrorReconnectCategory(errorCode, state = {}) {
  const code = sanitizeProtocolErrorCode(errorCode);
  const authenticated = state?.authenticated === true;
  const ready = state?.ready === true;
  if (code === "daemon_hello_timeout" && !authenticated) return "relay_handshake_timeout";
  if (code === "daemon_ready_timeout" && authenticated && !ready) return "relay_readiness_timeout";
  if (code === "daemon_transport_error") return "relay_transport_error";
  if (code === "daemon_liveness_timeout") return "relay_heartbeat_timeout";
  return "";
}

export function relayCloseCategory(code, reason = "") {
  const numeric = Number(code);
  const reasonText = String(reason || "");
  if (isSupersededClose(numeric, reasonText)) return "superseded";
  if (numeric === 1008 && reasonText === "daemon hello timeout") return "relay_handshake_timeout";
  if (numeric === 1008 && reasonText === "daemon ready timeout") return "relay_readiness_timeout";
  if ([1008, 1012].includes(numeric) && ["daemon pong failed", "daemon send failed"].includes(reasonText)) return "relay_transport_error";
  if ([1008, 1012].includes(numeric) && reasonText === "daemon liveness timeout") return "relay_heartbeat_timeout";
  if (numeric === 1008 && ["stale daemon candidate", "expired daemon candidate"].includes(reasonText)) return "relay_restarting_or_unavailable";
  if (numeric === 1008 && ["daemon hello required", "missing daemon attachment", "invalid daemon candidate timestamp"].includes(reasonText)) return "relay_protocol_error";
  if (numeric === 1000) return "normal_close";
  if (numeric === 1001 || numeric === 1012 || numeric === 1013) return "relay_restarting_or_unavailable";
  if (numeric === 1006) return "connection_interrupted";
  if (numeric === 1002) return "relay_protocol_error";
  if (numeric === 1007) return "invalid_transport_payload";
  if (numeric === 1008) return "relay_policy_rejected";
  if (numeric === 1009) return "message_too_large";
  if (numeric === 1011) return "relay_internal_error";
  return "unexpected_close";
}

export function relayOutageUserAction(category, outageMs) {
  if (Number(outageMs) < 5 * 60_000) return "";
  if (String(category || "") === "local_authority_revocation_retry") {
    return " If this persists, inspect local authority, process-session, and managed-job state; the retained revocation will retry automatically.";
  }
  return " If this persists, check internet access and the deployed Worker.";
}

export function relayFatalMessage(category) {
  if (category === "relay_protocol_mismatch") {
    return "remote relay identity or version does not match this daemon; upgrade and redeploy both components";
  }
  if (category === "relay_protocol_error") {
    return "remote relay protocol error; upgrade and redeploy both components, then restart the daemon";
  }
  if (category === "relay_proxy_configuration") {
    return "remote relay proxy configuration is invalid; check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY";
  }
  return "remote relay rejected the daemon connection; verify credentials or redeploy the Worker";
}

export function relayCloseUserCause(category) {
  const causes = {
    connection_interrupted: "connection interrupted",
    local_authority_revocation_retry: "local authority revocation requires retry",
    relay_restarting_or_unavailable: "relay restarting or temporarily unavailable",
    relay_policy_rejected: "relay rejected the connection",
    relay_internal_error: "relay internal error",
    relay_protocol_mismatch: "relay identity or version mismatch",
    relay_authentication_failed: "relay authentication failed",
    relay_connect_timeout: "relay connection attempt timed out",
    relay_handshake_timeout: "relay authentication acknowledgement timed out",
    relay_readiness_timeout: "end-to-end relay readiness verification timed out",
    relay_heartbeat_timeout: "relay stopped responding",
    relay_transport_timeout: "relay transport stopped responding",
    relay_transport_error: "relay transport error",
    relay_protocol_error: "relay protocol error",
    relay_proxy_configuration: "relay proxy configuration invalid",
    invalid_transport_payload: "invalid transport payload",
    message_too_large: "message exceeded the relay limit",
    normal_close: "connection closed",
    unexpected_close: "unexpected connection close",
    superseded: "connection superseded",
  };
  return causes[String(category || "")] || "connection interrupted";
}

export function welcomeMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_welcome";
  if (message.type !== "welcome") return "unexpected_welcome_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_welcome";
  return "";
}

export function acknowledgementMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_acknowledgement";
  if (message.type !== "hello_ack") return "unexpected_acknowledgement_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_acknowledgement";
  return "";
}

export function readinessMismatch(message, expectedServer = "", expectedVersion = "") {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_readiness_acknowledgement";
  if (message.type !== "ready_ack") return "unexpected_readiness_acknowledgement_type";
  if (expectedServer && message.server !== expectedServer) return "server_identity_mismatch";
  if (expectedVersion && message.version !== expectedVersion) return "server_version_mismatch";
  if (typeof message.server !== "string" || !message.server || typeof message.version !== "string" || !message.version) return "incomplete_readiness_acknowledgement";
  return "";
}

export function isRelayReadyContext(relayContext = {}, relay = null) {
  if (relayContext?.ready === true) return true;
  if (relayContext?.ready === false) return false;
  return Number(relayContext?.sessionId) > 0 && relay?.status?.()?.ready === true;
}

export function isSupersededClose(code, reason) {
  return Number(code) === 1012 && String(reason || "") === "replaced by verified daemon";
}

export function reconnectDelay(attempt, random = Math.random, previousAttemptDurationMs = 0, connectTimeoutMs = 15_000) {
  const safeAttempt = Math.max(0, Number.isFinite(Number(attempt)) ? Number(attempt) : 0);
  const base = Math.min(1000 * (2 ** Math.min(safeAttempt, 4)), 15_000);
  const spent = Math.max(0, Number(previousAttemptDurationMs) || 0);
  const connectBudget = Math.max(1, Number(connectTimeoutMs) || 15_000);
  const remaining = spent >= connectBudget * 0.8 ? Math.max(250, base - spent) : base;
  return remaining + Math.floor((typeof random === "function" ? random() : Math.random()) * 500);
}

export function sanitizeProtocolErrorCode(value) {
  const code = String(value || "unknown_error").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_PROTOCOL_ERROR_CODE_CHARS);
  return code || "unknown_error";
}
