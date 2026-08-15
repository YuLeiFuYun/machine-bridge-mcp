(() => {
  const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;
  const NONCE = /^[A-Za-z0-9_-]{32}$/;
  const PROOF = /^[A-Za-z0-9_-]{43}$/;
  const BROKER_AUTH_REQUEST_HEADER = "x-machine-bridge-broker-auth";
  const BROKER_AUTH_REQUEST_VALUE = "machine-bridge-browser-v2";

  async function extensionProtocol(endpoint, token) {
    if (!TOKEN.test(String(token || ""))) throw new Error("browser pairing token is invalid");
    const parsed = parseEndpoint(endpoint);
    if (!parsed) throw new Error("browser broker endpoint is invalid");
    const clientChallenge = randomBase64Url(24);
    const authUrl = new URL(endpoint);
    authUrl.protocol = "http:";
    authUrl.pathname = "/extension-auth";
    const initProof = await hmac(token, `machine-bridge-browser-extension-init-v2\0${clientChallenge}`);
    authUrl.search = `?challenge=${encodeURIComponent(clientChallenge)}&init=${encodeURIComponent(initProof)}`;
    const response = await brokerFetch(authUrl, "GET");
    if (response.status !== 204) throw new Error("browser broker authentication failed");
    const serverNonce = String(response.headers.get("x-machine-bridge-broker-nonce") || "");
    const serverProof = String(response.headers.get("x-machine-bridge-broker-proof") || "");
    if (!NONCE.test(serverNonce) || !PROOF.test(serverProof)) throw new Error("browser broker authentication failed");
    const expected = await hmac(token, `machine-bridge-browser-extension-server-v2\0${clientChallenge}\0${serverNonce}`);
    if (!fixedEqual(expected, serverProof)) throw new Error("browser broker authentication failed");
    const clientProof = await hmac(token, `machine-bridge-browser-extension-client-v2\0${clientChallenge}\0${serverNonce}`);
    return `mbm-extension-v2.${clientChallenge}.${serverNonce}.${clientProof}`;
  }

  function parseEndpoint(value) {
    let parsed;
    try { parsed = new URL(String(value || "")); } catch { return null; }
    const port = Number(parsed.port);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/extension"
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return parsed;
  }
  function pairingUrlFromEndpoint(endpoint) {
    const parsed = parseEndpoint(endpoint);
    return parsed ? `http://127.0.0.1:${parsed.port}/pair` : "";
  }
  function parsePairingPage(value) {
    let parsed;
    try { parsed = new URL(String(value || "")); } catch { return null; }
    const port = Number(parsed.port);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/pair"
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return parsed;
  }
  async function brokerFetch(url, method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      return await fetch(url, {
        method, redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
      });
    } finally { clearTimeout(timer); }
  }
  async function hmac(token, message) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
  }
  function randomBase64Url(size) {
    const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return base64Url(bytes);
  }
  function base64Url(bytes) {
    let binary = ""; for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function fixedEqual(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return difference === 0;
  }

  globalThis.__machineBridgeBrokerAuth = Object.freeze({
    extensionProtocol, pairingUrlFromEndpoint, parseBrokerEndpoint: parseEndpoint, parsePairingPage,
    internal: Object.freeze({ brokerFetch, fixedEqual, hmac, randomBase64Url, tokenPattern: TOKEN, noncePattern: NONCE, proofPattern: PROOF }),
  });
})();
