import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { classifyOperationalError } from "../core/log.mjs";

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
    return "remote relay proxy configuration is invalid; check MBM_RELAY_PROXY, MBM_RELAY_FALLBACK_PROXY, HTTP_PROXY, HTTPS_PROXY, and NO_PROXY";
  }
  if (category === "relay_device_session_expired") {
    return "daemon device session expired and could not be renewed; restart the daemon to obtain a fresh root-signed session certificate";
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
    relay_transport_send_timeout: "local relay transport send queue stopped making progress",
    relay_transport_error: "relay transport error",
    relay_protocol_error: "relay protocol error",
    relay_proxy_configuration: "relay proxy configuration invalid",
    relay_device_session_expired: "daemon device session certificate expired",
    relay_session_rotated: "daemon device session certificate rotated",
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
  if (!relayConnectionId(message.connection_id)) return "invalid_connection_identity";
  return "";
}

export function relayConnectionId(value) {
  return typeof value === "string" && /^connection_[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
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

export function reconnectDelay(attempt, random = Math.random, previousAttemptDurationMs = 0, connectTimeoutMs = 30_000) {
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
const MAX_CLOSE_REASON_CHARS = 128;

export function normalizeWorkerUrl(value) {
  if (typeof value !== "string") throw new Error("invalid Worker URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid Worker URL"); }
  if (url.protocol !== "https:") throw new Error("Worker URL must use HTTPS");
  if (url.username || url.password) throw new Error("Worker URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Worker URL must be an origin without a path, query, or fragment");
  return url.origin;
}

export function sanitizeCloseReason(value) {
  let text;
  try { text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""); } catch { text = ""; }
  return text.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CLOSE_REASON_CHARS);
}

export function terminateSocket(socket) {
  try {
    if (typeof socket?.terminate === "function") socket.terminate();
    else socket?.close?.();
  } catch { /* Relay generation state is authoritative even when close races. */ }
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return "<relay-url>"; }
}

export function classifyRelayTransportError(error) {
  const directStatus = Number(error?.statusCode ?? error?.response?.statusCode);
  if (directStatus === 401 || directStatus === 403) return "authentication_failed";
  const match = /^Unexpected server response: (\d{3})$/.exec(String(error?.message || ""));
  if (match && [401, 403].includes(Number(match[1]))) return "authentication_failed";
  const direct = classifyOperationalError(error);
  if (direct !== "execution_failed") return direct;
  const nested = Array.isArray(error?.errors) ? error.errors.map(classifyOperationalError) : [];
  if (nested.includes("network_error")) return "network_error";
  if (nested.includes("timeout")) return "timeout";
  return direct;
}

export function relayHttpStatusFromError(error) {
  const directStatus = Number(error?.statusCode ?? error?.response?.statusCode);
  if (Number.isInteger(directStatus) && directStatus >= 100 && directStatus <= 599) return directStatus;
  const match = /^Unexpected server response: (\d{3})$/.exec(String(error?.message || ""));
  const parsed = Number(match?.[1]);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

export function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function formatAttempts(value) {
  const attempts = Math.max(1, Math.floor(Number(value) || 1));
  return `${attempts} reconnect attempt${attempts === 1 ? "" : "s"}`;
}

export function formatDuration(milliseconds) {
  let seconds = Math.max(1, Math.round(Number(milliseconds) / 1000));
  const units = [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
  const parts = [];
  for (const [label, size] of units) {
    if (seconds < size && parts.length === 0) continue;
    const amount = Math.floor(seconds / size);
    if (amount > 0) {
      parts.push(`${amount} ${label}${amount === 1 ? "" : "s"}`);
      seconds -= amount * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "1 second";
}

export function tracedTlsConnection(onStage = () => {}) {
  return (options) => {
    const connectOptions = { ...options, path: undefined };
    if (!connectOptions.servername && connectOptions.servername !== "") {
      connectOptions.servername = isIP(connectOptions.host) ? "" : connectOptions.host;
    }
    onStage("tcp_connecting");
    const socket = tlsConnect(connectOptions);
    socket.once("lookup", (error) => observeTlsLookup(onStage, error));
    socket.once("connect", () => onStage("tcp_connected"));
    socket.once("secureConnect", () => onStage("tls_established"));
    return socket;
  };
}

export function observeTlsLookup(onStage, error) {
  if (!error) onStage("dns_resolved");
}
const CONNECT_STAGES = new Set([
  "socket_constructing", "proxy_connecting", "tcp_connecting", "dns_resolved",
  "tcp_connected", "tls_established", "http_rejected", "websocket_open",
]);

export class RelayConnectTiming {
  constructor(now) {
    this.now = now;
    this.startedAt = null;
    this.durationMs = 0;
    this.stage = "idle";
    this.httpStatus = null;
    this.milestones = {};
    this.lastFailure = null;
  }

  begin() {
    this.startedAt = this.now();
    this.stage = "socket_constructing";
    this.httpStatus = null;
    this.milestones = { socket_constructing: 0 };
  }

  observe(stage) {
    if (!Number.isFinite(this.startedAt)) return;
    const name = String(stage || "");
    if (!CONNECT_STAGES.has(name)) return;
    this.stage = name;
    this.milestones[name] = this.elapsed();
  }

  rejectHttp(status) {
    this.observe("http_rejected");
    this.httpStatus = Number.isInteger(status) ? status : null;
  }

  finish() {
    if (!Number.isFinite(this.startedAt)) return;
    this.durationMs = this.elapsed();
    this.startedAt = null;
  }

  captureFailure() {
    this.finish();
    this.lastFailure = {
      stage: this.stage, durationMs: Math.max(0, Math.round(this.durationMs)),
      milestones: { ...this.milestones }, httpStatus: this.httpStatus,
    };
  }

  elapsed() { return Math.max(0, Math.round(this.now() - this.startedAt)); }

  snapshot() {
    const failed = this.lastFailure;
    return {
      last_connect_stage: this.stage,
      last_connect_duration_ms: Number.isFinite(this.startedAt) ? this.elapsed() : Math.max(0, Math.round(this.durationMs)),
      last_connect_milestones_ms: { ...this.milestones },
      last_connect_http_status: this.httpStatus,
      last_failed_connect_stage: failed?.stage ?? null,
      last_failed_connect_duration_ms: failed?.durationMs ?? 0,
      last_failed_connect_milestones_ms: failed ? { ...failed.milestones } : {},
      last_failed_connect_http_status: failed?.httpStatus ?? null,
    };
  }
}
export function scheduleRelayReconnectBackoffReset(state, socket, sessionId) {
  state.clearTimer("reconnectStabilityTimer", "clearTimeout");
  if (state.reconnectAttempt <= 0) return;
  state.reconnectStabilityTimer = state.scheduler.setTimeout(() => {
    state.reconnectStabilityTimer = null;
    if (state.closed || state.socket !== socket || !state.ready || state.activeSessionId !== sessionId) return;
    state.reconnectAttempt = 0;
  }, state.reconnectStableReadyMs);
  state.reconnectStabilityTimer?.unref?.();
}

export function settleRelayReconnectBackoffOnClose(state, wasReady, readyDurationMs) {
  state.clearTimer("reconnectStabilityTimer", "clearTimeout");
  if (wasReady && Number(readyDurationMs) >= state.reconnectStableReadyMs) state.reconnectAttempt = 0;
}

export function scheduleRelayReconnect(state, category) {
  if (state.closed || state.reconnectTimer) return;
  state.recordOutage(category);
  const delay = state.reconnectDelay(state.reconnectAttempt++, Math.random, state.connectTiming.durationMs, state.connectTimeoutMs);
  state.lastReconnectDelayMs = delay;
  state.nextReconnectAt = state.now() + delay;
  state.nextReconnectWallAt = state.wallNow() + delay;
  state.scheduleOutageWarning();
  state.logger.debug?.("scheduling daemon reconnect", {
    delay_ms: delay,
    next_reconnect_at: new Date(state.nextReconnectWallAt).toISOString(),
    attempt: state.outageAttempts,
    close_category: state.lastCloseCategory,
    network_route: state.networkRoute,
    network_route_scope: state.networkRouteScope,
  });
  state.reconnectTimer = state.scheduler.setTimeout(() => {
    state.reconnectTimer = null;
    state.nextReconnectAt = 0;
    state.nextReconnectWallAt = 0;
    state.connect();
  }, delay);
  state.reconnectTimer?.unref?.();
}
