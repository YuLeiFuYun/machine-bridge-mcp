import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { isAllowedExtensionOrigin, isAllowedLoopbackHost } from "./browser-pairing-store.mjs";

export async function startBrowserBrokerServer({ port, token, maxPayload, onHttp, onSocket }) {
  const server = createServer(onHttp);
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
      if (url.pathname === "/extension" && protocol === `mbm.${token}` && isAllowedExtensionOrigin(origin)) role = "extension";
      if (url.pathname === "/runtime" && protocol === `mbm-runtime.${token}` && !origin) role = "runtime";
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
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
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
