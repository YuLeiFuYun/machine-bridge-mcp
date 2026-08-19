import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { classifyOperationalError } from "./log.mjs";

const MAX_CLOSE_REASON_CHARS = 128;

export function normalizeWorkerUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("invalid Worker URL"); }
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
