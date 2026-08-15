import http from "node:http";
import https from "node:https";
import { appName } from "./package-identity.mjs";
import { proxyAgentForHttp } from "./network-proxy.mjs";

const MAX_HEALTH_BODY_BYTES = 64 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const NON_RETRYABLE_HEALTH_ERRORS = new Set(["missing_worker_url", "invalid_worker_url", "proxy_configuration"]);
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKERS_DEV_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;

export async function workerHealth(workerUrl, expectedVersion, options = {}) {
  if (!workerUrl) return { ok: false, error: "missing_worker_url" };
  let healthUrl;
  try {
    healthUrl = workerHealthUrl(workerUrl, options.expectedWorkerName);
  } catch {
    return { ok: false, error: "invalid_worker_url" };
  }

  try {
    const probe = typeof options.probe === "function" ? options.probe : requestAllowedWorkerHealthJson;
    const result = await probe(healthUrl, {
      timeoutMs: options.timeoutMs,
      proxyResolver: options.proxyResolver,
      proxyAgentForUrl: options.proxyAgentForUrl,
    });
    const networkRoute = result.networkRoute || "direct";
    if (result.statusCode !== 200) return { ok: false, error: `HTTP ${result.statusCode}`, networkRoute };
    const body = result.body;
    const observedVersion = healthVersion(body?.version);
    if (body?.ok !== true || body?.server !== appName || !observedVersion) {
      return { ok: false, error: "unexpected_health_response", networkRoute };
    }
    if (observedVersion !== expectedVersion) return { ok: false, error: `version_mismatch:${observedVersion}!=${expectedVersion}`, networkRoute };
    return { ok: true, version: observedVersion, networkRoute };
  } catch (error) {
    return {
      ok: false,
      error: workerHealthError(error),
      networkRoute: error?.networkRoute || (hasErrorCode(error, "http_proxy_configuration") ? "invalid-proxy-configuration" : "unknown"),
    };
  }
}

export async function retryWorkerHealth(workerUrl, expectedVersion, attempts, options = {}) {
  const count = Math.max(1, Number.parseInt(String(attempts), 10) || 1);
  const wait = typeof options.wait === "function" ? options.wait : sleep;
  let last = { ok: false, error: "not_checked" };
  for (let index = 0; index < count; index += 1) {
    last = await workerHealth(workerUrl, expectedVersion, options);
    if (last.ok) return last;
    if (!isRetryableWorkerHealthError(last.error)) return last;
    if (index + 1 < count) await wait(1_000 + index * 500);
  }
  return last;
}

export function normalizeWorkerOrigin(workerUrl, expectedWorkerName = "") {
  const base = new URL(String(workerUrl));
  const hostname = base.hostname.toLowerCase();
  const expectedName = String(expectedWorkerName || "").toLowerCase();
  if (base.protocol !== "https:" || base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Worker URL must be an HTTPS workers.dev origin");
  }
  if (!WORKERS_DEV_HOST.test(hostname)) throw new Error("Worker URL must use a workers.dev hostname");
  if (expectedName && (!WORKER_NAME.test(expectedName) || hostname.split(".")[0] !== expectedName)) {
    throw new Error("Worker URL hostname does not match the recorded Worker name");
  }
  return `https://${hostname}`;
}

export function workerHealthUrl(workerUrl, expectedWorkerName = "") {
  return `${normalizeWorkerOrigin(workerUrl, expectedWorkerName)}/healthz`;
}

function healthVersion(value) {
  const version = typeof value === "string" ? value : "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version) ? version : "";
}

export function isRetryableWorkerHealthError(value) {
  return !NON_RETRYABLE_HEALTH_ERRORS.has(String(value || ""));
}

export function workerHealthRequiresRedeploy(value) {
  const reason = String(value || "");
  return reason.startsWith("version_mismatch:")
    || reason === "unexpected_health_response"
    || reason === "HTTP 404"
    || reason === "HTTP 410";
}

export function workerHealthUserReason(value) {
  const reason = String(value || "");
  if (reason.startsWith("version_mismatch:")) return "deployed version does not match the local package";
  if (/^HTTP \d+$/.test(reason)) return "health endpoint returned an HTTP error";
  if (reason === "unexpected_health_response") return "health endpoint returned an unexpected response";
  if (reason === "timeout") return "health check timed out";
  if (reason === "tls_error") return "TLS validation failed";
  if (reason === "network_error") return "network request failed";
  if (reason === "proxy_configuration") return "HTTP proxy configuration is invalid";
  if (reason === "missing_worker_url") return "Worker URL is missing";
  if (reason === "invalid_worker_url") return "Worker URL is invalid";
  return "health check failed";
}

export function workerHealthError(error) {
  if (hasErrorCode(error, "http_proxy_configuration")) return "proxy_configuration";
  if (hasErrorCode(error, "ETIMEDOUT") || hasErrorCode(error, "ABORT_ERR") || /timeout|timed out|aborted/i.test(errorMessages(error))) return "timeout";
  if (hasTlsError(error)) return "tls_error";
  if (hasNetworkError(error)) return "network_error";
  return "request_failed";
}

export function requestWorkerHealthJson(url, options = {}) {
  return requestJson(new URL(String(url)), {
    timeoutMs: boundedTimeout(options.timeoutMs),
    proxyResolver: options.proxyResolver,
    proxyAgentForUrl: options.proxyAgentForUrl,
  });
}

function requestAllowedWorkerHealthJson(url, options = {}) {
  const target = new URL(String(url));
  if (target.protocol !== "https:" || target.port || target.pathname !== "/healthz" || target.search || target.hash || !WORKERS_DEV_HOST.test(target.hostname)) {
    const error = new Error("health request target is not an allowed workers.dev endpoint");
    error.code = "ERR_INVALID_WORKER_HEALTH_URL";
    throw error;
  }
  return requestJson(target, {
    timeoutMs: boundedTimeout(options.timeoutMs),
    proxyResolver: options.proxyResolver,
    proxyAgentForUrl: options.proxyAgentForUrl,
  });
}

function requestJson(target, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const selectProxy = typeof options.proxyAgentForUrl === "function" ? options.proxyAgentForUrl : proxyAgentForHttp;
    let proxy;
    try {
      proxy = selectProxy(target.href, options.proxyResolver);
    } catch (error) {
      rejectPromise(withNetworkRoute(error, "invalid-proxy-configuration"));
      return;
    }
    const networkRoute = proxy?.agent ? "proxy" : "direct";
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      headers: {
        Accept: "application/json",
        "User-Agent": "machine-bridge-mcp-health",
      },
      ...(proxy?.agent ? { agent: proxy.agent } : {}),
    });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const rejectWithRoute = (error) => finish(() => rejectPromise(withNetworkRoute(error, networkRoute)));
    const timer = setTimeout(() => {
      const error = new Error(`health request timed out after ${options.timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    }, options.timeoutMs);
    timer.unref?.();

    request.on("response", (response) => {
      const statusCode = Number(response.statusCode || 0);
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_HEALTH_BODY_BYTES) {
          const error = new Error("health response exceeded the size limit");
          error.code = "ERR_RESPONSE_TOO_LARGE";
          response.destroy(error);
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", rejectWithRoute);
      response.on("end", () => {
        if (settled) return;
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // Invalid JSON is reported through the normal unexpected-health-response classification.
        }
        finish(() => resolvePromise({ statusCode, body, networkRoute }));
      });
    });
    request.on("error", rejectWithRoute);
    request.end();
  });
}

function withNetworkRoute(error, networkRoute) {
  const value = error instanceof Error ? error : new Error(String(error));
  if (!value.networkRoute) value.networkRoute = networkRoute;
  return value;
}

function hasTlsError(error) {
  const codes = errorCodes(error);
  if (codes.some((code) => code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || code.includes("CERTIFICATE") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT")) return true;
  return /certificate|\bTLS\b|\bSSL\b/i.test(errorMessages(error));
}

function hasNetworkError(error) {
  const networkCodes = new Set([
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETRESET",
    "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
  ]);
  if (errorCodes(error).some((code) => networkCodes.has(code))) return true;
  return /fetch failed|network|socket hang up|connection reset|connection refused/i.test(errorMessages(error));
}

function hasErrorCode(error, expected) {
  return errorCodes(error).includes(expected);
}

function errorCodes(error) {
  const codes = [];
  for (let current = error; current && typeof current === "object"; current = current.cause) {
    if (typeof current.code === "string") codes.push(current.code);
  }
  return codes;
}

function errorMessages(error) {
  const messages = [];
  for (let current = error; current; current = current?.cause) {
    messages.push(String(current?.message || current));
    if (typeof current !== "object") break;
  }
  return messages.join(" ");
}

function boundedTimeout(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(60_000, Math.floor(numeric)) : DEFAULT_HEALTH_TIMEOUT_MS;
}

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
