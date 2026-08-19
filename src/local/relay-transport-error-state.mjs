const REASON_BY_CODE = new Map([
  ["ECONNRESET", "connection_reset"], ["ECONNREFUSED", "connection_refused"],
  ["ECONNABORTED", "connection_aborted"], ["ETIMEDOUT", "connection_timeout"],
  ["ESOCKETTIMEDOUT", "connection_timeout"], ["ENETUNREACH", "network_unreachable"],
  ["EHOSTUNREACH", "host_unreachable"], ["ENETDOWN", "network_down"],
  ["EADDRNOTAVAIL", "local_address_unavailable"], ["EPIPE", "broken_pipe"],
  ["ENOTFOUND", "dns_not_found"], ["EAI_AGAIN", "dns_temporary_failure"],
]);

export class RelayTransportErrorState {
  constructor() { this.clear(); }

  record(errorClass, { error = null, ready = false, authenticated = false } = {}) {
    this.errorClass = String(errorClass || "");
    this.reason = classifyRelayTransportErrorReason(error);
    this.ready = ready === true;
    this.authenticated = authenticated === true;
    return this.errorClass;
  }

  clear() {
    this.errorClass = "";
    this.reason = "unknown";
    this.ready = false;
    this.authenticated = false;
  }

  snapshot() {
    return this.errorClass ? {
      last_transport_error_reason: this.reason,
      last_transport_error_ready: this.ready,
      last_transport_error_authenticated: this.authenticated,
    } : {};
  }
}

export function classifyRelayTransportErrorReason(error) {
  const code = String(error?.code || "").toUpperCase();
  if (code === "DAEMON_HTTP_TIMEOUT") return "connection_timeout";
  if (REASON_BY_CODE.has(code)) return REASON_BY_CODE.get(code);
  if (code.startsWith("ERR_TLS_CERT_") || code.includes("CERTIFICATE") || code.includes("CERT_")) return "tls_certificate";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) return "tls_protocol";
  const nested = Array.isArray(error?.errors)
    ? [...new Set(error.errors.map(classifyRelayTransportErrorReason).filter((reason) => reason !== "unknown"))] : [];
  if (nested.length === 1) return nested[0];
  if (nested.length > 1) return "multi_address_failure";
  return "unknown";
}
