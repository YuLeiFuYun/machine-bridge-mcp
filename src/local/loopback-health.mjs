import { request as requestHttp } from "node:http";

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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
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
    client.setTimeout(timeoutMs, () => client.destroy(new Error("loopback health request timed out")));
    client.on("error", () => finish(null));
    client.end();
  });
}
