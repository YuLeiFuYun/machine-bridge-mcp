(() => {
  const GRANT = /^(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
  const PAIRING_GRANT_TTL_MS = 30_000;

  async function bootstrapPairing(port, grant, now = Date.now()) {
    const auth = globalThis.__machineBridgeBrokerAuth?.internal;
    if (!auth) throw new Error("browser broker authentication module is unavailable");
    const normalizedPort = Number(port);
    const match = GRANT.exec(String(grant || ""));
    const current = Number(now);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535 || !match || !Number.isFinite(current)) {
      throw new Error("browser pairing bootstrap is invalid");
    }
    const expiresAt = Number(match[1]);
    if (expiresAt < current || expiresAt - current > PAIRING_GRANT_TTL_MS) throw new Error("browser pairing bootstrap expired");
    const grantId = `${match[1]}.${match[2]}`;
    const secret = match[3];
    const clientChallenge = auth.randomBase64Url(24);
    const authUrl = new URL(`http://127.0.0.1:${normalizedPort}/pair-auth`);
    authUrl.searchParams.set("grant", grantId);
    authUrl.searchParams.set("challenge", clientChallenge);
    const initProof = await auth.hmac(secret, `machine-bridge-browser-pair-init-v2\0${grantId}\0${clientChallenge}`);
    authUrl.searchParams.set("init", initProof);
    const first = await auth.brokerFetch(authUrl, "GET");
    if (first.status !== 204) throw new Error("browser pairing broker authentication failed");
    const serverNonce = String(first.headers.get("x-machine-bridge-broker-nonce") || "");
    const serverProof = String(first.headers.get("x-machine-bridge-broker-proof") || "");
    if (!auth.noncePattern.test(serverNonce) || !auth.proofPattern.test(serverProof)) throw new Error("browser pairing broker authentication failed");
    const expected = await auth.hmac(secret, `machine-bridge-browser-pair-server-v2\0${grantId}\0${clientChallenge}\0${serverNonce}`);
    if (!auth.fixedEqual(expected, serverProof)) throw new Error("browser pairing broker authentication failed");
    const clientProof = await auth.hmac(secret, `machine-bridge-browser-pair-client-v2\0${grantId}\0${clientChallenge}\0${serverNonce}`);
    authUrl.searchParams.set("nonce", serverNonce);
    authUrl.searchParams.set("proof", clientProof);
    const second = await auth.brokerFetch(authUrl, "POST");
    if (second.status !== 204) throw new Error("browser pairing broker authentication failed");
    const token = String(second.headers.get("x-machine-bridge-extension-token") || "");
    if (!auth.tokenPattern.test(token)) throw new Error("browser pairing broker returned an invalid extension credential");
    return { endpoint: `ws://127.0.0.1:${normalizedPort}/extension`, token };
  }

  globalThis.__machineBridgePairingBootstrap = Object.freeze({ bootstrapPairing });
})();
