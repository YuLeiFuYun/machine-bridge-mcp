import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

export function proxyAgentForWebSocket(webSocketUrl, proxyResolver = getProxyForUrl) {
  const target = new URL(String(webSocketUrl));
  if (target.protocol !== "ws:" && target.protocol !== "wss:") throw new Error("relay WebSocket URL must use ws or wss");
  const proxyLookupUrl = new URL(target);
  proxyLookupUrl.protocol = target.protocol === "wss:" ? "https:" : "http:";
  const proxyValue = String(proxyResolver(proxyLookupUrl.href) || "").trim();
  if (!proxyValue) return { agent: null, mode: "direct" };
  let proxyUrl;
  try {
    proxyUrl = new URL(proxyValue);
  } catch {
    throw proxyConfigurationError("relay proxy configuration is not a valid URL");
  }
  if (!new Set(["http:", "https:"]).has(proxyUrl.protocol)) {
    throw proxyConfigurationError("relay proxy must use HTTP or HTTPS");
  }
  try {
    return {
      agent: new HttpsProxyAgent(proxyUrl),
      mode: "proxy",
    };
  } catch {
    throw proxyConfigurationError("relay proxy configuration could not be initialized");
  }
}

function proxyConfigurationError(message) {
  const error = new Error(message);
  error.code = "relay_proxy_configuration";
  return error;
}
