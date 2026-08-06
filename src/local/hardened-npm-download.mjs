import https from "node:https";
import { proxyAgentForHttp } from "./network-proxy.mjs";

const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export function downloadHardenedNpmArtifact(artifact, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(artifact.url);
    if (target.protocol !== "https:" || target.username || target.password || target.port || target.search || target.hash) {
      rejectPromise(new Error(`${artifact.name} tarball URL is not an exact HTTPS registry URL`));
      return;
    }
    let proxy;
    try {
      const selectProxy = typeof options.proxyAgentForUrl === "function" ? options.proxyAgentForUrl : proxyAgentForHttp;
      proxy = selectProxy(target.href, options.proxyResolver);
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const requestFn = typeof options.request === "function" ? options.request : https.request;
    const request = requestFn({
      protocol: target.protocol,
      hostname: target.hostname,
      method: "GET",
      path: target.pathname,
      headers: { Accept: "application/octet-stream", "User-Agent": "machine-bridge-mcp-hardened-npm" },
      ...(proxy?.agent ? { agent: proxy.agent } : {}),
    });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => request.destroy(Object.assign(new Error(`${artifact.name} tarball download timed out`), { code: "ETIMEDOUT" })), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    request.once("error", (error) => finish(() => rejectPromise(error)));
    request.once("response", (response) => {
      const status = Number(response.statusCode || 0);
      if (status !== 200) {
        response.resume();
        finish(() => rejectPromise(new Error(`failed to download ${artifact.name} ${artifact.version}: HTTP ${status || "unknown"}`)));
        return;
      }
      const declaredBytes = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.maximumBytes) {
        response.destroy();
        finish(() => rejectPromise(new Error(`${artifact.name} tarball exceeds its byte limit`)));
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
      response.once("error", (error) => finish(() => rejectPromise(error)));
      response.once("end", () => finish(() => resolvePromise(Buffer.concat(chunks, total))));
    });
    request.end();
  });
}
