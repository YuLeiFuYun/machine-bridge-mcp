import { EXPECTED_EXTENSION_VERSION } from "./browser-extension-protocol.mjs";
import { EXPECTED_EXTENSION_ID } from "./browser-extension-identity.mjs";
import { isAllowedLoopbackHost, pairingHtml, securityHeaders, sendJson } from "./browser-pairing-http.mjs";

export function handleBrowserBridgeHttp(request, response, {
  port,
  token,
  extensionConnected,
  extensionStatusInfo,
  extensionReloadRequired,
}) {
  const host = String(request.headers.host || "");
  if (!isAllowedLoopbackHost(host, port)) {
    response.writeHead(403, securityHeaders("text/plain; charset=utf-8"));
    response.end("Forbidden\n");
    return;
  }
  const url = new URL(request.url || "/", `http://${host}`);
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
    return;
  }
  if (url.pathname === "/healthz") {
    const extension = extensionStatusInfo();
    sendJson(response, {
      ok: true,
      connected: extensionConnected(),
      broker: "machine-bridge-browser",
      expected_extension_version: EXPECTED_EXTENSION_VERSION,
      expected_extension_id: EXPECTED_EXTENSION_ID,
      extension_id: extension?.extension_id || "",
      extension_protocol: extension?.protocol || null,
      extension_version: extension?.version || "",
      extension_capabilities: extension?.capabilities || [],
      extension_reload_required: extensionReloadRequired(),
      controls_existing_profile: true,
      controls_extension_profile: true,
      machine_bridge_launches_browser: false,
      profile_identity_verifiable: false,
    });
    return;
  }
  if (url.pathname === "/pair") {
    const html = pairingHtml(port, token);
    response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
    response.end(html);
    return;
  }
  response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
  response.end("Not found\n");
}
