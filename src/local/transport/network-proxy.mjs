import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import http, { request as requestHttp } from "node:http";
import https from "node:https";
import { appName } from "../core/timing.mjs";
import { isWorkerName } from "../state/worker-identity-contract.mjs";
import { RemoteIdleSleepAssertions } from "../core/idle-sleep-assertions.mjs";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const RELAY_HTTP_PROXY_AGENT_CACHE_LIMIT = 4;

const relayHttpProxyAgents = new Map();

export const RELAY_PROXY_ENVIRONMENT_KEY = "MBM_RELAY_PROXY";

export const RELAY_FALLBACK_PROXY_ENVIRONMENT_KEY = "MBM_RELAY_FALLBACK_PROXY";

export function proxyAgentForWebSocket(webSocketUrl, proxyResolver = getProxyForUrl, environment = process.env) {
  const target = new URL(String(webSocketUrl));
  if (target.protocol !== "ws:" && target.protocol !== "wss:") throw new Error("relay WebSocket URL must use ws or wss");
  const lookupUrl = new URL(target);
  lookupUrl.protocol = target.protocol === "wss:" ? "https:" : "http:";
  return proxyAgentForRelayLookup(lookupUrl, proxyResolver, environment, {
    errorCode: "relay_proxy_configuration",
    subject: "relay proxy",
  });
}

export function proxyAgentForRelayHttp(httpUrl, proxyResolver = getProxyForUrl, environment = process.env) {
  const target = new URL(String(httpUrl));
  if (!HTTP_PROTOCOLS.has(target.protocol)) throw new Error("relay HTTP URL must use http or https");
  const options = { reuseRelayHttpAgent: true };
  if (Object.hasOwn(environment || {}, RELAY_FALLBACK_PROXY_ENVIRONMENT_KEY)) {
    const fallbackProxy = String(environment[RELAY_FALLBACK_PROXY_ENVIRONMENT_KEY] ?? "").trim();
    if (fallbackProxy) {
      return proxyAgentForValue(fallbackProxy, {
        errorCode: "relay_proxy_configuration",
        subject: "relay fallback proxy",
      }, options);
    }
    return proxyAgentForLookup(target, proxyResolver, {
      errorCode: "relay_proxy_configuration",
      subject: "relay fallback proxy",
    }, options);
  }
  return proxyAgentForRelayLookup(target, proxyResolver, environment, {
    errorCode: "relay_proxy_configuration",
    subject: "relay proxy",
  }, options);
}

export function proxyAgentForHttp(httpUrl, proxyResolver = getProxyForUrl) {
  const target = new URL(String(httpUrl));
  if (!HTTP_PROTOCOLS.has(target.protocol)) throw new Error("HTTP request URL must use http or https");
  return proxyAgentForLookup(target, proxyResolver, {
    errorCode: "http_proxy_configuration",
    subject: "HTTP proxy",
  });
}

function proxyAgentForRelayLookup(lookupUrl, proxyResolver, environment, context, options = {}) {
  const explicitProxy = Object.hasOwn(environment || {}, RELAY_PROXY_ENVIRONMENT_KEY)
    ? String(environment[RELAY_PROXY_ENVIRONMENT_KEY] ?? "").trim()
    : "";
  if (explicitProxy) return proxyAgentForValue(explicitProxy, context, options);
  return proxyAgentForLookup(lookupUrl, proxyResolver, context, options);
}

function proxyAgentForLookup(lookupUrl, proxyResolver, context, options = {}) {
  const proxyValue = String(proxyResolver(lookupUrl.href) || "").trim();
  if (!proxyValue) return { agent: null, mode: "direct" };
  return proxyAgentForValue(proxyValue, context, options);
}

function proxyAgentForValue(proxyValue, context, options = {}) {
  let proxyUrl;
  try {
    proxyUrl = new URL(proxyValue);
  } catch {
    throw proxyConfigurationError(`${context.subject} configuration is not a valid URL`, context.errorCode);
  }
  if (!HTTP_PROTOCOLS.has(proxyUrl.protocol)) {
    throw proxyConfigurationError(`${context.subject} must use HTTP or HTTPS`, context.errorCode);
  }
  try {
    return {
      agent: options.reuseRelayHttpAgent === true
        ? reusableRelayHttpProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl),
      mode: "proxy",
    };
  } catch {
    throw proxyConfigurationError(`${context.subject} configuration could not be initialized`, context.errorCode);
  }
}

function reusableRelayHttpProxyAgent(proxyUrl) {
  const key = proxyUrl.href;
  const existing = relayHttpProxyAgents.get(key);
  if (existing) {
    relayHttpProxyAgents.delete(key);
    relayHttpProxyAgents.set(key, existing);
    return existing;
  }
  const agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
  relayHttpProxyAgents.set(key, agent);
  while (relayHttpProxyAgents.size > RELAY_HTTP_PROXY_AGENT_CACHE_LIMIT) {
    const oldestKey = relayHttpProxyAgents.keys().next().value;
    const oldest = relayHttpProxyAgents.get(oldestKey);
    relayHttpProxyAgents.delete(oldestKey);
    try { oldest?.destroy?.(); } catch { /* Bounded cache eviction must not turn proxy selection into a transport failure. */ }
  }
  return agent;
}

function proxyConfigurationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
export function readLoopbackJson(input, options = {}) {
  let target;
  try { target = new URL(String(input)); } catch { return Promise.resolve(null); }
  const pathname = typeof options.pathname === "string" && options.pathname.startsWith("/") ? options.pathname : "/healthz";
  const port = Number(target.port);
  if (target.protocol !== "http:"
      || target.hostname !== "127.0.0.1"
      || target.pathname !== pathname
      || target.username || target.password || target.search || target.hash
      || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return Promise.resolve(null);
  }
  const request = typeof options.request === "function" ? options.request : requestHttp;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : 2000;
  const maximumBytes = Number.isFinite(Number(options.maximumBytes)) ? Math.max(1, Number(options.maximumBytes)) : 64 * 1024;
  return new Promise((resolvePromise) => {
    let settled = false;
    let client;
    let deadlineTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      client?.destroy();
      resolvePromise(value);
    };
    deadlineTimer = setTimeout(() => finish(null), timeoutMs);
    try {
      client = request({
        protocol: "http:", hostname: "127.0.0.1", port, path: pathname, method: "GET", agent: false,
        headers: { accept: "application/json", connection: "close" },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maximumBytes) {
            client.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          try {
            const value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
            finish(value && typeof value === "object" && !Array.isArray(value) ? value : null);
          } catch {
            finish(null);
          }
        });
        response.on("error", () => finish(null));
      });
    } catch {
      finish(null);
      return;
    }
    if (settled) { client.destroy(); return; }
    client.setTimeout(timeoutMs, () => client.destroy(new Error("loopback health request timed out")));
    client.on("error", () => finish(null));
    client.end();
  });
}
const MAX_HEALTH_BODY_BYTES = 64 * 1024;

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

const NON_RETRYABLE_HEALTH_ERRORS = new Set(["missing_worker_url", "invalid_worker_url", "proxy_configuration"]);

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
  if (typeof workerUrl !== "string" || typeof expectedWorkerName !== "string") {
    throw new Error("Worker URL and recorded Worker name must be strings");
  }
  const base = new URL(workerUrl);
  const hostname = base.hostname.toLowerCase();
  const expectedName = expectedWorkerName.toLowerCase();
  if (base.protocol !== "https:" || base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Worker URL must be an HTTPS workers.dev origin");
  }
  if (!WORKERS_DEV_HOST.test(hostname)) throw new Error("Worker URL must use a workers.dev hostname");
  if (expectedName && (!isWorkerName(expectedName) || hostname.split(".")[0] !== expectedName)) {
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
    requestFactory: options.requestFactory,
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
    requestFactory: options.requestFactory,
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
    const requestOptions = {
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
    };
    let request;
    try {
      const requestFactory = typeof options.requestFactory === "function"
        ? options.requestFactory
        : (value) => transport.request(value);
      request = requestFactory(requestOptions);
    } catch (error) {
      rejectPromise(withNetworkRoute(error, networkRoute));
      return;
    }
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
export class RemoteActivityIdleSleepTimeline {
  constructor({ wallNow = Date.now } = {}) {
    this.wallNow = wallNow;
    this.lastActivityStartedAt = 0;
    this.lastActivityEndedAt = 0;
    this.graceReleaseDueAt = 0;
    this.lastReleaseAt = 0;
    this.lastReleaseReason = null;
  }

  activityStarted() { this.lastActivityStartedAt = this.wallNow(); }
  activityEnded() { this.lastActivityEndedAt = this.wallNow(); }
  graceArmed(graceMs) { this.graceReleaseDueAt = this.wallNow() + graceMs; }
  graceCancelled() { this.graceReleaseDueAt = 0; }
  released(reason) {
    this.lastReleaseAt = this.wallNow();
    this.lastReleaseReason = reason;
  }

  snapshot() {
    return {
      grace_release_due_at: isoTime(this.graceReleaseDueAt),
      last_activity_started_at: isoTime(this.lastActivityStartedAt),
      last_activity_ended_at: isoTime(this.lastActivityEndedAt),
      last_release_at: isoTime(this.lastReleaseAt),
      last_release_reason: this.lastReleaseReason,
    };
  }
}

function isoTime(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
export const DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS = 30 * 60_000;

export class RemoteActivityIdleSleepGuard {
  constructor({ platform = process.platform, daemonPid = process.pid, graceMs = DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS,
    mode = "activity", spawnProcess, setTimer = setTimeout, clearTimer = clearTimeout, wallNow = Date.now, logger = console } = {}) {
    this.assertions = new RemoteIdleSleepAssertions({ mode, platform, processId: daemonPid, spawnProcess, setTimer, clearTimer, wallNow, logger });
    this.enabled = this.assertions.supported && Number.isSafeInteger(graceMs) && graceMs > 0;
    this.graceMs = this.enabled ? graceMs : 0;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.timeline = new RemoteActivityIdleSleepTimeline({ wallNow }); this.releaseTimer = null; this.activeActivities = 0;
  }
  start() { return this.enabled ? this.assertions.start() : false; }
  beginActivity() {
    if (!this.enabled) return false;
    this.timeline.activityStarted(); this.activeActivities += 1;
    this.cancelReleaseTimer();
    return this.assertions.beginActivity();
  }
  endActivity() {
    if (!this.enabled) return false;
    if (this.activeActivities <= 0) return this.assertions.snapshot().active;
    this.timeline.activityEnded(); this.activeActivities -= 1;
    if (!this.assertions.usesActivityGrace()) return this.assertions.snapshot().active;
    if (this.activeActivities > 0 || !this.assertions.activityActive()) return this.assertions.snapshot().active;
    try {
      this.armReleaseTimer();
      return true;
    } catch (error) {
      this.release();
      this.assertions.reportUnavailable(error);
      return false;
    }
  }
  cancelReleaseTimer() {
    const timer = this.releaseTimer;
    this.releaseTimer = null; this.timeline.graceCancelled();
    if (!timer) return;
    try { this.clearTimer(timer); } catch { /* Stale timer callbacks also check identity before release. */ }
  }
  armReleaseTimer() {
    this.cancelReleaseTimer(); this.timeline.graceArmed(this.graceMs);
    const timer = this.setTimer(() => {
      if (this.releaseTimer !== timer || this.activeActivities > 0) return;
      this.releaseTimer = null; this.timeline.graceCancelled();
      this.release("inactivity_grace_expired");
    }, this.graceMs);
    timer?.unref?.();
    this.releaseTimer = timer;
  }
  release(reason = "explicit_release") {
    const wasActive = this.assertions.activityActive();
    this.cancelReleaseTimer(); this.assertions.releaseActivity();
    if (wasActive) this.timeline.released(reason);
  }
  stop() {
    this.activeActivities = 0;
    this.release("runtime_stop");
    this.assertions.stop();
  }
  snapshot() {
    const assertion = this.assertions.snapshot();
    return {
      supported: assertion.supported, enabled: this.enabled, mode: assertion.mode,
      active: assertion.active,
      requests_idle_sleep_prevention: assertion.requests_idle_sleep_prevention,
      requests_system_sleep_prevention_on_ac: assertion.requests_system_sleep_prevention_on_ac,
      active_activities: this.activeActivities,
      grace_ms: this.graceMs,
      ...this.timeline.snapshot(),
      last_error_class: assertion.last_error_class,
      assertion_generation: assertion.assertion_generation,
      restart_count: assertion.restart_count,
      recovery_pending: assertion.recovery_pending,
      unprotected_duration_ms: assertion.unprotected_duration_ms,
      last_unprotected_duration_ms: assertion.last_unprotected_duration_ms,
    };
  }
}
