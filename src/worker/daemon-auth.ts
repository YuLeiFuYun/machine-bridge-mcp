import { DAEMON_AUTH_CHALLENGE_TTL_SECONDS, DAEMON_AUTH_SCHEME, DAEMON_PREFLIGHT_SCHEME, DAEMON_PREFLIGHT_TTL_SECONDS, daemonAuthTranscript, daemonPreflightTranscript } from "../shared/daemon-auth.mjs";
import { safeEqual } from "./oauth-state.ts";
import { consumeBoundedNonce } from "./nonce-store.ts";
import {
  decodeBase64Url,
  parsePublicJwk,
  publicKeyId,
  verifyDeviceSessionCertificate,
  verifyP256Signature,
} from "./device-session-verifier.ts";

const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

export interface DaemonChallenge {
  scheme: typeof DAEMON_AUTH_SCHEME;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  workerOrigin: string;
}

export function createDaemonChallenge(workerOrigin: string, now = Math.floor(Date.now() / 1000)): DaemonChallenge {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return {
    scheme: DAEMON_AUTH_SCHEME,
    challenge: `daemon_challenge_${base64Url(bytes)}`,
    issuedAt: now,
    expiresAt: now + DAEMON_AUTH_CHALLENGE_TTL_SECONDS,
    workerOrigin: normalizeWorkerOrigin(workerOrigin),
  };
}

export function sanitizeDaemonChallengeAttachment(value: Record<string, unknown>): Partial<{
  authChallenge: string;
  authIssuedAt: number;
  authExpiresAt: number;
  workerOrigin: string;
  authSessionPublicKeyJson: string;
  authSessionKeyId: string;
  authCertificateExpiresAt: number;
}> {
  const authChallenge = typeof value.authChallenge === "string" && /^daemon_challenge_[A-Za-z0-9_-]{40,96}$/.test(value.authChallenge)
    ? value.authChallenge
    : undefined;
  const authIssuedAt = positiveSafeInteger(value.authIssuedAt);
  const authExpiresAt = positiveSafeInteger(value.authExpiresAt);
  const authCertificateExpiresAt = positiveSafeInteger(value.authCertificateExpiresAt);
  const authSessionKeyId = typeof value.authSessionKeyId === "string" && /^device_[A-Za-z0-9_-]{32}$/.test(value.authSessionKeyId)
    ? value.authSessionKeyId
    : undefined;
  let workerOrigin: string | undefined;
  try { workerOrigin = normalizeWorkerOrigin(String(value.workerOrigin || "")); } catch {}
  let authSessionPublicKeyJson: string | undefined;
  try { authSessionPublicKeyJson = JSON.stringify(parsePublicJwk(String(value.authSessionPublicKeyJson || ""))); } catch {}
  return { authChallenge, authIssuedAt, authExpiresAt, workerOrigin, authSessionPublicKeyJson, authSessionKeyId, authCertificateExpiresAt };
}

export interface DaemonPreflightAuthorization {
  nonce: string;
  expiresAt: number;
  sessionPublicKeyJson: string;
  sessionKeyId: string;
  certificateExpiresAt: number;
}

export async function verifyDaemonPreflight(input: {
  publicKeyJson: string;
  headers: Headers;
  workerOrigin: string;
  server: string;
  version: string;
  now?: number;
}): Promise<DaemonPreflightAuthorization | null> {
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  const certificate = await verifyDeviceSessionCertificate({
    encodedCertificate: input.headers.get(SESSION_CERTIFICATE_HEADER) || "",
    rootPublicKeyJson: input.publicKeyJson,
    workerOrigin: input.workerOrigin,
    server: input.server,
    version: input.version,
    now,
  });
  if (!certificate) return null;
  const scheme = input.headers.get("X-Bridge-Device-Scheme") || "";
  const keyId = input.headers.get("X-Bridge-Device-Key") || "";
  const nonce = input.headers.get("X-Bridge-Device-Nonce") || "";
  const issuedAt = Number(input.headers.get("X-Bridge-Device-Time"));
  const signature = decodeBase64Url(input.headers.get("X-Bridge-Device-Signature") || "", 64);
  if (scheme !== DAEMON_PREFLIGHT_SCHEME || !signature) return null;
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > DAEMON_PREFLIGHT_TTL_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce)) return null;
  if (!(await safeEqual(keyId, certificate.sessionKeyId))) return null;
  let transcript: string;
  try {
    transcript = daemonPreflightTranscript({ workerOrigin: input.workerOrigin, server: input.server, version: input.version, nonce, issuedAt });
  } catch {
    return null;
  }
  if (!(await verifyP256Signature(certificate.sessionPublicJwk, transcript, signature))) return null;
  return {
    nonce,
    expiresAt: issuedAt + DAEMON_PREFLIGHT_TTL_SECONDS,
    sessionPublicKeyJson: certificate.sessionPublicKeyJson,
    sessionKeyId: certificate.sessionKeyId,
    certificateExpiresAt: certificate.expiresAt,
  };
}

export async function consumeDaemonPreflightNonce(
  storage: DurableObjectStorage,
  authorization: DaemonPreflightAuthorization,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return consumeBoundedNonce(storage, {
    key: "daemon-preflight-nonces",
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
    now,
    noncePattern: /^[A-Za-z0-9_-]{24,128}$/,
    maximum: 128,
  });
}

export async function verifyDaemonAuthentication(input: {
  publicKeyJson: string;
  authentication: unknown;
  challenge: DaemonChallenge;
  server: string;
  version: string;
  instanceId: string;
  certificateExpiresAt?: number;
  now?: number;
}): Promise<boolean> {
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  if (now < input.challenge.issuedAt - 5 || now > input.challenge.expiresAt) return false;
  if (input.certificateExpiresAt !== undefined && (!Number.isSafeInteger(input.certificateExpiresAt) || now > input.certificateExpiresAt)) return false;
  if (!input.authentication || typeof input.authentication !== "object" || Array.isArray(input.authentication)) return false;
  const auth = input.authentication as Record<string, unknown>;
  if (auth.scheme !== DAEMON_AUTH_SCHEME) return false;
  if (!(await safeEqual(String(auth.challenge || ""), input.challenge.challenge))) return false;
  if (Number(auth.issued_at) !== input.challenge.issuedAt) return false;
  const signature = decodeBase64Url(String(auth.signature || ""), 64);
  if (!signature) return false;
  let publicJwk: JsonWebKey;
  try { publicJwk = parsePublicJwk(input.publicKeyJson); } catch { return false; }
  if (!(await safeEqual(String(auth.key_id || ""), await publicKeyId(publicJwk)))) return false;
  let transcript: string;
  try {
    transcript = daemonAuthTranscript({
      challenge: input.challenge.challenge,
      workerOrigin: input.challenge.workerOrigin,
      server: input.server,
      version: input.version,
      instanceId: input.instanceId,
      issuedAt: input.challenge.issuedAt,
    });
  } catch {
    return false;
  }
  return verifyP256Signature(publicJwk, transcript, signature);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function positiveSafeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeWorkerOrigin(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("invalid Worker origin");
  }
  return url.origin;
}
