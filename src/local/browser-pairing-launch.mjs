import { createServer } from "node:http";
import { pairingHtml, securityHeaders } from "./browser-pairing-http.mjs";
import { createBrowserPairingGrant } from "./browser-pairing-grant.mjs";

const LAUNCH_TTL_MS = 30_000;

export async function startBrowserPairingLaunch({ brokerPort, extensionToken, timeoutMs = LAUNCH_TTL_MS, serverFactory = createServer } = {}) {
  const targetPort = Number(brokerPort);
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) throw new Error("browser pairing broker port is invalid");
  const grant = createBrowserPairingGrant(extensionToken, targetPort);
  const ttl = Number(timeoutMs);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > LAUNCH_TTL_MS) throw new Error("browser pairing launch timeout is invalid");

  let listenerPort = 0;
  let closed = false;
  let timer;
  let resolveClosed;
  const closedPromise = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  const server = serverFactory((request, response) => {
    const host = String(request.headers.host || "");
    if (!listenerPort || host.toLowerCase() !== `127.0.0.1:${listenerPort}`) {
      response.writeHead(403, securityHeaders("text/plain; charset=utf-8")).end("forbidden\n");
      return;
    }
    let url;
    try { url = new URL(request.url || "/", `http://${host}`); }
    catch { response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end("bad request\n"); return; }
    if (request.method !== "GET" || url.pathname !== "/pair" || url.search) {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8")).end("not found\n");
      return;
    }
    const html = pairingHtml(targetPort);
    response.writeHead(200, { ...securityHeaders("text/html; charset=utf-8"), "content-length": Buffer.byteLength(html) });
    response.end(html, () => close());
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try { server.close(() => resolveClosed()); } catch { resolveClosed(); }
  };
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => { server.off("listening", onListening); rejectPromise(error); };
    const onListening = () => { server.off("error", onError); resolvePromise(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.on("error", close);
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("browser pairing launch listener address is unavailable"); }
  listenerPort = address.port;
  timer = setTimeout(close, ttl);
  timer.unref?.();
  const fragment = new URLSearchParams({ broker_port: String(targetPort), grant: String(grant) }).toString();
  return { url: `http://127.0.0.1:${listenerPort}/pair#${fragment}`, close, closed: closedPromise, listenerPort, brokerPort: targetPort };
}
