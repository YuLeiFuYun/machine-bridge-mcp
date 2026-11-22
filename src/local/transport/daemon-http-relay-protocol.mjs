import { createHash, randomBytes } from "node:crypto";
import { DAEMON_HTTP_RELAY_SCHEME, daemonHttpRelayTranscript } from "../../shared/daemon-auth.mjs";
import { encodeDeviceSessionCertificate, signWithDeviceSessionIdentity, validateDeviceSessionIdentity } from "../state/device-identity.mjs";
import http from "node:http";
import https from "node:https";
import { relayRetryAfterMs } from "./relay-recovery.mjs";
import { proxyAgentForRelayHttp } from "./network-proxy.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };

const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

export function createDaemonHttpRelayHeaders(identity, workerOrigin, server, version, body, now = Date.now()) {
  validateDeviceSessionIdentity(identity, now);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("daemon HTTP relay timestamp is invalid");
  const nonce = randomBytes(24).toString("base64url");
  const bodySha256 = createHash("sha256").update(body).digest("base64url");
  const signature = signWithDeviceSessionIdentity(identity, daemonHttpRelayTranscript({
    workerOrigin, server, version, nonce, issuedAt, bodySha256,
  }), now);
  return {
    "content-type": "application/json; charset=utf-8",
    "X-Bridge-Device-Scheme": DAEMON_HTTP_RELAY_SCHEME,
    "X-Bridge-Device-Key": identity.keyId,
    "X-Bridge-Device-Nonce": nonce,
    "X-Bridge-Device-Time": String(issuedAt),
    "X-Bridge-Body-SHA256": bodySha256,
    "X-Bridge-Device-Signature": signature,
    [SESSION_CERTIFICATE_HEADER]: encodeDeviceSessionCertificate(identity, now),
  };
}
export function postDaemonHttpRelay({ url, headers, body, timeoutMs, maximumResponseBytes, signal, request: requestOverride, selectProxy = proxyAgentForRelayHttp }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      if (typeof url !== "string") throw new TypeError("relay URL must be a string");
      target = new URL(url);
    } catch {
      reject(relayRequestError("daemon_http_invalid_url", "daemon HTTP relay URL is invalid"));
      return;
    }
    const client = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
    if (!client) { reject(relayRequestError("daemon_http_invalid_url", "daemon HTTP relay URL must use HTTP or HTTPS")); return; }
    let proxy;
    try { proxy = selectProxy(target.href); }
    catch (error) { reject(error); return; }
    const requestClient = typeof requestOverride === "function" ? requestOverride : client.request.bind(client);
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = requestClient(target, {
      method: "POST", headers, ...(proxy.agent ? { agent: proxy.agent } : {}), ...(signal ? { signal } : {}),
    }, (response) => {
      const declared = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(declared) && declared > maximumResponseBytes) {
        response.destroy();
        finish(relayRequestError("daemon_http_response_too_large", "daemon HTTP relay response exceeded its byte limit"));
        return;
      }
      const chunks = [];
      let observed = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        observed += chunk.length;
        if (observed > maximumResponseBytes) {
          response.destroy();
          finish(relayRequestError("daemon_http_response_too_large", "daemon HTTP relay response exceeded its byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, {
        statusCode: Number(response.statusCode) || 0,
        retryAfterMs: relayRetryAfterMs(Number(response.statusCode), response.headers["retry-after"]),
        body: Buffer.concat(chunks, observed).toString("utf8"),
        networkRoute: proxy.agent ? "application-http-proxy" : "system-network-stack",
      }));
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    timer = setTimeout(() => {
      const error = relayRequestError("daemon_http_timeout", "daemon HTTP relay request timed out");
      request.destroy(error);
      finish(error);
    }, Math.max(1, Number(timeoutMs) || 1));
    timer.unref?.();
    request.end(body);
  });
}

function relayRequestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
export class RelayOutboundSequence {
  constructor() { this.next = 1; this.acknowledged = 0; this.bytes = 0; this.messages = []; }
  enqueue(payload) {
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > relayContract.httpFallbackMaximumMessageBytes
        || this.messages.length >= relayContract.httpFallbackMaximumQueuedMessages
        || this.bytes + bytes > relayContract.httpFallbackMaximumQueuedBytes) {
      throw new Error("daemon HTTP relay outbound queue capacity exceeded");
    }
    this.messages.push({ seq: this.next++, payload, bytes });
    this.bytes += bytes;
  }
  acknowledge(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= this.next) return false;
    if (sequence <= this.acknowledged) return true;
    this.acknowledged = sequence;
    while (this.messages[0]?.seq <= sequence) {
      const removed = this.messages.shift();
      if (removed) this.bytes = Math.max(0, this.bytes - removed.bytes);
    }
    return true;
  }
  snapshot(maximumBytes = relayContract.httpFallbackMaximumEnvelopeBytes) {
    const selected = []; let bytes = 2;
    for (const message of this.messages) {
      const item = { seq: message.seq, payload: message.payload };
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (selected.length ? 1 : 0);
      if (bytes + itemBytes > maximumBytes) break;
      selected.push(item); bytes += itemBytes;
    }
    return selected;
  }
  reset() { this.next = 1; this.acknowledged = 0; this.bytes = 0; this.messages.length = 0; }
}

export class RelayInboundSequence {
  constructor() { this.acknowledged = 0; }
  classify(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return "gap";
    if (sequence <= this.acknowledged) return "duplicate";
    return sequence === this.acknowledged + 1 ? "new" : "gap";
  }
  commit(sequence) {
    if (sequence !== this.acknowledged + 1) throw new Error("daemon HTTP relay inbound sequence is not contiguous");
    this.acknowledged = sequence;
  }
  reset() { this.acknowledged = 0; }
}
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
