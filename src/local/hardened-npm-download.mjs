import https from "node:https";
const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const PROXY_URL_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];
const CONTROL_CHARACTERS = /[\0\r\n]/;
export function downloadHardenedNpmArtifact(artifact, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(artifact.url);
    if (target.protocol !== "https:" || target.username || target.password || target.port || target.search || target.hash) {
      rejectPromise(new Error(`${artifact.name} tarball URL is not an exact HTTPS registry URL`));
      return;
    }
    let context = null;
    let request;
    try {
      context = prepareRequestAgent(target, options);
      const requestFn = typeof options.request === "function" ? options.request : https.request;
      request = requestFn({
        protocol: target.protocol, hostname: target.hostname, method: "GET", path: target.pathname,
        headers: { Accept: "application/octet-stream", "User-Agent": "machine-bridge-mcp-hardened-npm" },
        ...(context.agent ? { agent: context.agent } : {}),
      });
    } catch (error) {
      rejectPromise(cleanupResult(context, error, `${artifact.name} tarball download setup failed`));
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outcome = cleanupResult(context, error, `${artifact.name} tarball download failed`);
      if (outcome) rejectPromise(outcome);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => request.destroy(Object.assign(new Error(`${artifact.name} tarball download timed out`), { code: "ETIMEDOUT" })), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    request.once("error", (error) => finish(error));
    request.once("response", (response) => {
      const status = Number(response.statusCode || 0);
      if (status !== 200) {
        response.resume();
        finish(new Error(`failed to download ${artifact.name} ${artifact.version}: HTTP ${status || "unknown"}`));
        return;
      }
      const declaredBytes = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.maximumBytes) {
        response.destroy();
        finish(new Error(`${artifact.name} tarball exceeds its byte limit`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > artifact.maximumBytes || total > MAX_DOWNLOAD_BYTES) {
          response.destroy(Object.assign(new Error(`${artifact.name} tarball exceeds its byte limit`), { code: "ERR_RESPONSE_TOO_LARGE" }));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => finish(null, Buffer.concat(chunks, total)));
    });
    request.end();
  });
}

function prepareRequestAgent(target, options) {
  if (typeof options.proxyAgentForUrl === "function") {
    return { agent: options.proxyAgentForUrl(target.href, options.proxyResolver)?.agent || null };
  }
  if (Object.hasOwn(options, "agent")) return { agent: options.agent || null };
  const proxyEnv = normalizeProxyEnvironment(options.proxyEnv ?? process.env);
  const agent = (typeof options.createAgent === "function" ? options.createAgent : proxyAgentForHttp)(proxyEnv);
  if (!agent || typeof agent !== "object") throw new Error("hardened npm proxy agent could not be initialized");
  return { agent, dispose: typeof agent.destroy === "function" ? () => agent.destroy() : null };
}

function normalizeProxyEnvironment(source) {
  if (!source || typeof source !== "object") throw proxyConfigurationError("HTTP proxy environment must be an object");
  const normalized = {};
  for (const key of PROXY_URL_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    const value = String(source[key]).trim();
    if (!value) { normalized[key] = ""; continue; }
    if (CONTROL_CHARACTERS.test(value)) throw proxyConfigurationError("HTTP proxy configuration contains a prohibited control character");
    let proxyUrl;
    try { proxyUrl = new URL(value); } catch { throw proxyConfigurationError("HTTP proxy configuration is not a valid URL"); }
    if (!HTTP_PROTOCOLS.has(proxyUrl.protocol)) throw proxyConfigurationError("HTTP proxy configuration must use HTTP or HTTPS");
    normalized[key] = proxyUrl.href;
  }
  for (const key of NO_PROXY_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    const value = String(source[key]);
    if (CONTROL_CHARACTERS.test(value)) throw proxyConfigurationError("NO_PROXY configuration contains a prohibited control character");
    normalized[key] = value;
  }
  return normalized;
}
function proxyAgentForHttp(proxyEnv) { return new https.Agent({ proxyEnv }); }
function proxyConfigurationError(message) { return Object.assign(new Error(message), { code: "http_proxy_configuration" }); }
function cleanupResult(context, primary, message) {
  try { context?.dispose?.(); return primary; }
  catch (cleanup) { return primary ? new AggregateError([primary, cleanup], `${message} and proxy-agent cleanup was incomplete`) : cleanup; }
}
