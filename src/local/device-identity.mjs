import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { DAEMON_AUTH_SCHEME, DAEMON_PREFLIGHT_SCHEME, daemonAuthTranscript, daemonPreflightTranscript } from "../shared/daemon-auth.mjs";
import {
  DEVICE_SESSION_CERTIFICATE_SCHEME,
  DEVICE_SESSION_MAX_LIFETIME_SECONDS,
  canonicalPublicJwk,
  deviceSessionCertificateTranscript,
} from "../shared/device-session-auth.mjs";

const DEVICE_KEY_TYPE = "EC";
const DEVICE_CURVE = "P-256";
const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

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

export function createDeviceSessionIdentity(rootIdentity, workerOrigin, server, version, now = Date.now()) {
  validateDeviceIdentity(rootIdentity);
  const draft = createDeviceSessionDraft(rootIdentity, workerOrigin, server, version, now);
  return finalizeDeviceSessionIdentity(draft, signDeviceTranscript(rootIdentity, draft.transcript), now);
}

export function createDeviceSessionDraft(rootIdentity, workerOrigin, server, version, now = Date.now()) {
  validatePublicDeviceRoot(rootIdentity);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("device session timestamp is invalid");
  const expiresAt = issuedAt + DEVICE_SESSION_MAX_LIFETIME_SECONDS;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  validatePrivateDeviceJwk(privateJwk);
  validatePublicDeviceJwk(publicJwk);
  const nonce = randomBytes(24).toString("base64url");
  const certificateBody = {
    scheme: DEVICE_SESSION_CERTIFICATE_SCHEME,
    root_key_id: rootIdentity.keyId,
    public_jwk: canonicalPublicJwk(publicJwk),
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce,
  };
  const transcript = deviceSessionCertificateTranscript({
    workerOrigin,
    server,
    version,
    rootKeyId: rootIdentity.keyId,
    publicJwk,
    issuedAt,
    expiresAt,
    nonce,
  });
  return {
    transcript,
    certificateBody,
    session: {
      scheme: DAEMON_AUTH_SCHEME,
      privateJwk,
      publicJwk,
      keyId: deviceKeyId(publicJwk),
      createdAt: new Date(Number(now)).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    },
  };
}

export function finalizeDeviceSessionIdentity(draft, signature, now = Date.now()) {
  if (!draft || typeof draft !== "object" || !draft.session || !draft.certificateBody) throw new Error("device session draft is invalid");
  if (!/^[A-Za-z0-9_-]{86}$/.test(String(signature || ""))) throw new Error("device session root signature is invalid");
  const identity = {
    ...draft.session,
    certificate: { ...draft.certificateBody, signature },
  };
  return validateDeviceSessionIdentity(identity, now);
}

export function validatePublicDeviceRoot(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("device root identity is missing");
  if (identity.scheme !== DAEMON_AUTH_SCHEME) throw new Error("device root identity scheme is invalid");
  validatePublicDeviceJwk(identity.publicJwk);
  if (identity.keyId !== deviceKeyId(identity.publicJwk)) throw new Error("device root identity key id is invalid");
  if (!Number.isFinite(Date.parse(String(identity.createdAt || "")))) throw new Error("device root identity creation time is invalid");
  return identity;
}

export function publicDeviceJwkJson(identity) {
  const publicJwk = identity?.publicJwk;
  validatePublicDeviceJwk(publicJwk);
  return JSON.stringify(publicJwk);
}

export function createDaemonPreflightHeaders(identity, workerOrigin, server, version, now = Date.now()) {
  validateDeviceSessionIdentity(identity, now);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("device preflight timestamp is invalid");
  const nonce = randomBytes(24).toString("base64url");
  const transcript = daemonPreflightTranscript({ workerOrigin, server, version, nonce, issuedAt });
  const signature = signDeviceTranscript(identity, transcript);
  return {
    "X-Bridge-Device-Scheme": DAEMON_PREFLIGHT_SCHEME,
    "X-Bridge-Device-Key": identity.keyId,
    "X-Bridge-Device-Nonce": nonce,
    "X-Bridge-Device-Time": String(issuedAt),
    "X-Bridge-Device-Signature": signature,
    [SESSION_CERTIFICATE_HEADER]: encodeDeviceSessionCertificate(identity, now),
  };
}

export function encodeDeviceSessionCertificate(identity, now = Date.now()) {
  validateDeviceSessionIdentity(identity, now);
  return Buffer.from(JSON.stringify(identity.certificate), "utf8").toString("base64url");
}

export function signWithDeviceSessionIdentity(identity, transcript, now = Date.now()) {
  validateDeviceSessionIdentity(identity, now);
  const text = String(transcript || "");
  if (!text || Buffer.byteLength(text) > 64 * 1024) throw new Error("device session signing transcript is empty or too large");
  return signDeviceTranscript(identity, text);
}

export async function createDaemonAuthentication(identity, welcome, instanceId) {
  validateDeviceSessionIdentity(identity);
  const auth = welcome?.authentication;
  if (!auth || auth.scheme !== DAEMON_AUTH_SCHEME) throw new Error("Worker did not provide a supported device challenge");
  const challenge = String(auth.challenge || "");
  const issuedAt = Number(auth.issued_at);
  const expiresAt = Number(auth.expires_at);
  if (!/^daemon_challenge_[A-Za-z0-9_-]{40,96}$/.test(challenge)) throw new Error("Worker device challenge is invalid");
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new Error("Worker device challenge lifetime is invalid");
  if (Math.floor(Date.now() / 1000) > expiresAt) throw new Error("Worker device challenge expired");
  const transcript = daemonAuthTranscript({
    challenge,
    workerOrigin: String(welcome.worker_origin || ""),
    server: String(welcome.server || ""),
    version: String(welcome.version || ""),
    instanceId,
    issuedAt,
  });
  return {
    scheme: DAEMON_AUTH_SCHEME,
    key_id: identity.keyId,
    challenge,
    issued_at: issuedAt,
    signature: signDeviceTranscript(identity, transcript),
  };
}

export function validateDeviceIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("device identity is missing");
  if (identity.scheme !== DAEMON_AUTH_SCHEME) throw new Error("device identity scheme is invalid");
  validatePrivateDeviceJwk(identity.privateJwk);
  validatePublicDeviceJwk(identity.publicJwk);
  const expectedPublic = publicFromPrivate(identity.privateJwk);
  if (!samePublicJwk(expectedPublic, identity.publicJwk)) throw new Error("device identity public and private keys do not match");
  if (identity.keyId !== deviceKeyId(identity.publicJwk)) throw new Error("device identity key id is invalid");
  if (!Number.isFinite(Date.parse(String(identity.createdAt || "")))) throw new Error("device identity creation time is invalid");
  return identity;
}

export function validateDeviceSessionIdentity(identity, now = Date.now()) {
  validateDeviceIdentity(identity);
  const certificate = identity.certificate;
  if (!certificate || typeof certificate !== "object" || Array.isArray(certificate)) throw new Error("device session certificate is missing");
  if (certificate.scheme !== DEVICE_SESSION_CERTIFICATE_SCHEME) throw new Error("device session certificate scheme is invalid");
  if (identity.keyId !== deviceKeyId(certificate.public_jwk) || !samePublicJwk(identity.publicJwk, certificate.public_jwk)) {
    throw new Error("device session certificate key mismatch");
  }
  const expiresAt = Number(certificate.expires_at);
  if (!Number.isSafeInteger(expiresAt) || Math.floor(Number(now) / 1000) > expiresAt) {
    throw Object.assign(new Error("device session certificate expired"), { code: "device_session_expired" });
  }
  if (!/^[A-Za-z0-9_-]{86}$/.test(String(certificate.signature || ""))) throw new Error("device session certificate signature is invalid");
  return identity;
}

export function deviceKeyId(publicJwk) {
  validatePublicDeviceJwk(publicJwk);
  const canonical = JSON.stringify(canonicalPublicJwk(publicJwk));
  return `device_${createHash("sha256").update(canonical).digest("base64url").slice(0, 32)}`;
}

function signDeviceTranscript(identity, transcript) {
  validatePrivateDeviceJwk(identity?.privateJwk);
  const key = createPrivateKey({ key: identity.privateJwk, format: "jwk" });
  return sign("sha256", Buffer.from(transcript, "utf8"), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function publicFromPrivate(privateJwk) {
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  return privateKey.export({ format: "jwk" });
}

function validatePrivateDeviceJwk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("device private key is invalid");
  if (value.kty !== DEVICE_KEY_TYPE || value.crv !== DEVICE_CURVE || typeof value.d !== "string") throw new Error("device private key is invalid");
  validatePublicDeviceJwk(value);
}

function validatePublicDeviceJwk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("device public key is invalid");
  if (value.kty !== DEVICE_KEY_TYPE || value.crv !== DEVICE_CURVE || typeof value.x !== "string" || typeof value.y !== "string") throw new Error("device public key is invalid");
}

function samePublicJwk(left, right) {
  return left?.kty === right?.kty && left?.crv === right?.crv && left?.x === right?.x && left?.y === right?.y;
}
