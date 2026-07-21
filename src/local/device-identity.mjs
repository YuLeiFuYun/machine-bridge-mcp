import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, webcrypto } from "node:crypto";
import { DAEMON_AUTH_SCHEME, DAEMON_PREFLIGHT_SCHEME, daemonAuthTranscript, daemonPreflightTranscript } from "../shared/daemon-auth.mjs";

const DEVICE_KEY_TYPE = "EC";
const DEVICE_CURVE = "P-256";

export function createDeviceIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  validatePrivateDeviceJwk(privateJwk);
  validatePublicDeviceJwk(publicJwk);
  return {
    scheme: DAEMON_AUTH_SCHEME,
    privateJwk,
    publicJwk,
    keyId: deviceKeyId(publicJwk),
    createdAt: new Date().toISOString(),
  };
}

export function publicDeviceJwkJson(identity) {
  const publicJwk = identity?.publicJwk;
  validatePublicDeviceJwk(publicJwk);
  return JSON.stringify(publicJwk);
}


export function createDaemonPreflightHeaders(identity, workerOrigin, server, version, now = Date.now()) {
  validatePrivateDeviceJwk(identity?.privateJwk);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("device preflight timestamp is invalid");
  const nonce = randomBytes(24).toString("base64url");
  const transcript = daemonPreflightTranscript({ workerOrigin, server, version, nonce, issuedAt });
  const key = createPrivateKey({ key: identity.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(transcript, "utf8"), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return {
    "X-Bridge-Device-Scheme": DAEMON_PREFLIGHT_SCHEME,
    "X-Bridge-Device-Key": String(identity.keyId || deviceKeyId(identity.publicJwk)),
    "X-Bridge-Device-Nonce": nonce,
    "X-Bridge-Device-Time": String(issuedAt),
    "X-Bridge-Device-Signature": signature,
  };
}

export async function createDaemonAuthentication(identity, welcome, instanceId) {
  validatePrivateDeviceJwk(identity?.privateJwk);
  const auth = welcome?.authentication;
  if (!auth || auth.scheme !== DAEMON_AUTH_SCHEME) throw new Error("Worker did not request supported device authentication");
  const workerOrigin = new URL(String(welcome.worker_origin || "")).origin;
  const transcript = daemonAuthTranscript({
    challenge: auth.challenge,
    workerOrigin,
    server: welcome.server,
    version: welcome.version,
    instanceId,
    issuedAt: auth.issued_at,
  });
  const privateKey = await webcrypto.subtle.importKey(
    "jwk",
    identity.privateJwk,
    { name: "ECDSA", namedCurve: DEVICE_CURVE },
    false,
    ["sign"],
  );
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(transcript),
  );
  return {
    scheme: DAEMON_AUTH_SCHEME,
    challenge: String(auth.challenge),
    issued_at: Number(auth.issued_at),
    key_id: String(identity.keyId || deviceKeyId(identity.publicJwk)),
    signature: Buffer.from(signature).toString("base64url"),
  };
}

export function deviceKeyId(publicJwk) {
  validatePublicDeviceJwk(publicJwk);
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  return `device_${createHash("sha256").update(canonical).digest("base64url").slice(0, 32)}`;
}

export function validateDeviceIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("device identity is missing");
  if (identity.scheme !== DAEMON_AUTH_SCHEME) throw new Error("device identity scheme is unsupported");
  validatePrivateDeviceJwk(identity.privateJwk);
  validatePublicDeviceJwk(identity.publicJwk);
  const expectedKeyId = deviceKeyId(identity.publicJwk);
  if (identity.keyId !== expectedKeyId) throw new Error("device identity key id does not match its public key");
  return identity;
}

function validatePrivateDeviceJwk(jwk) {
  validatePublicDeviceJwk(jwk);
  if (typeof jwk.d !== "string" || !/^[A-Za-z0-9_-]{40,48}$/.test(jwk.d)) throw new Error("device private key is invalid");
}

function validatePublicDeviceJwk(jwk) {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new Error("device public key is invalid");
  if (jwk.kty !== DEVICE_KEY_TYPE || jwk.crv !== DEVICE_CURVE) throw new Error("device public key must use P-256");
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("device public key coordinates are invalid");
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(jwk.x) || !/^[A-Za-z0-9_-]{42,44}$/.test(jwk.y)) {
    throw new Error("device public key coordinates are invalid");
  }
}
