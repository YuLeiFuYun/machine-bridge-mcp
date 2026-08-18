import http from "node:http";
import https from "node:https";
import { proxyAgentForHttp } from "./network-proxy.mjs";

export function postDaemonHttpRelay({ url, headers, body, timeoutMs, maximumResponseBytes, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(String(url));
    const client = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
    if (!client) { reject(relayRequestError("daemon_http_invalid_url", "daemon HTTP relay URL must use HTTP or HTTPS")); return; }
    let proxy;
    try { proxy = proxyAgentForHttp(target.href); }
    catch (error) { reject(error); return; }
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = client.request(target, {
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
