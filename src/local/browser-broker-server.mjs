import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { isAllowedExtensionOrigin, isAllowedLoopbackHost } from "./browser-pairing-http.mjs";
import { EXPECTED_EXTENSION_ID } from "./browser-extension-identity.mjs";
import { createBrokerAuthRegistry } from "./browser-broker-auth.mjs";
import { createBrowserBrokerAuthHttpHandler } from "./browser-broker-auth-http.mjs";

export async function startBrowserBrokerServer({ port, extensionToken, runtimeToken, maxPayload, onHttp, onSocket }) {
  const runtimeAuth = createBrokerAuthRegistry(runtimeToken, "runtime");
  const extensionAuth = createBrokerAuthRegistry(extensionToken, "extension");
  const handleAuthHttp = createBrowserBrokerAuthHttpHandler({ port, extensionToken, runtimeAuth, extensionAuth });
  const server = createServer((request, response) => {
    if (!handleAuthHttp(request, response)) onHttp(request, response);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  server.on("upgrade", (request, socket, head) => {
    try {
      const host = String(request.headers.host || "");
      if (!isAllowedLoopbackHost(host, port)) {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      const url = new URL(request.url || "/", `http://${host}`);
      const protocol = String(request.headers["sec-websocket-protocol"] || "");
      const origin = String(request.headers.origin || "");
      let role = "";
      if (url.pathname === "/extension" && isAllowedExtensionOrigin(origin, EXPECTED_EXTENSION_ID) && extensionAuth.consume(protocol)) role = "extension";
      if (url.pathname === "/runtime" && !origin && runtimeAuth.consume(protocol)) role = "runtime";
      if (!role) {
        rejectUpgrade(socket, "401 Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.bridgeRole = role;
        wss.emit("connection", ws, request);
      });
    } catch {
      socket.destroy();
    }
  });
  wss.on("connection", (ws) => onSocket(ws, ws.bridgeRole));
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      try { wss.close(); }
      catch { /* Startup failure already owns the result; closing an unopened/half-open WebSocket server is best-effort. */ }
      try { server.close(); }
      catch { /* Startup failure already owns the result; closing an unopened/half-open HTTP server is best-effort. */ }
      rejectPromise(error);
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return { server, wss };
}

function rejectUpgrade(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
