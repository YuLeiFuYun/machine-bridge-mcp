import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
export const RELAY_PROXY_ENVIRONMENT_KEY = "MBM_RELAY_PROXY";

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
  return proxyAgentForRelayLookup(target, proxyResolver, environment, {
    errorCode: "relay_proxy_configuration",
    subject: "relay proxy",
  });
}

export function proxyAgentForHttp(httpUrl, proxyResolver = getProxyForUrl) {
  const target = new URL(String(httpUrl));
  if (!HTTP_PROTOCOLS.has(target.protocol)) throw new Error("HTTP request URL must use http or https");
  return proxyAgentForLookup(target, proxyResolver, {
    errorCode: "http_proxy_configuration",
    subject: "HTTP proxy",
  });
}

function proxyAgentForRelayLookup(lookupUrl, proxyResolver, environment, context) {
  const explicitProxy = Object.hasOwn(environment || {}, RELAY_PROXY_ENVIRONMENT_KEY)
    ? String(environment[RELAY_PROXY_ENVIRONMENT_KEY] ?? "").trim()
    : "";
  if (explicitProxy) return proxyAgentForValue(explicitProxy, context);
  return proxyAgentForLookup(lookupUrl, proxyResolver, context);
}

function proxyAgentForLookup(lookupUrl, proxyResolver, context) {
  const proxyValue = String(proxyResolver(lookupUrl.href) || "").trim();
  if (!proxyValue) return { agent: null, mode: "direct" };
  return proxyAgentForValue(proxyValue, context);
}

function proxyAgentForValue(proxyValue, context) {
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
      agent: new HttpsProxyAgent(proxyUrl),
      mode: "proxy",
    };
  } catch {
    throw proxyConfigurationError(`${context.subject} configuration could not be initialized`, context.errorCode);
  }
}

function proxyConfigurationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
