import { DAEMON_AUTH_CHALLENGE_TTL_SECONDS, DAEMON_AUTH_SCHEME, DAEMON_PREFLIGHT_SCHEME, DAEMON_PREFLIGHT_TTL_SECONDS, daemonAuthTranscript, daemonPreflightTranscript } from "../shared/daemon-auth.mjs";
import { safeEqual } from "./oauth-state.ts";
import { consumeBoundedNonce } from "./nonce-store.ts";

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
}> {
  const authChallenge = typeof value.authChallenge === "string" && /^daemon_challenge_[A-Za-z0-9_-]{40,96}$/.test(value.authChallenge)
    ? value.authChallenge
    : undefined;
  const authIssuedAt = positiveSafeInteger(value.authIssuedAt);
  const authExpiresAt = positiveSafeInteger(value.authExpiresAt);
  let workerOrigin: string | undefined;
  try { workerOrigin = normalizeWorkerOrigin(String(value.workerOrigin || "")); } catch {}
  return { authChallenge, authIssuedAt, authExpiresAt, workerOrigin };
}

export interface DaemonPreflightAuthorization {
  nonce: string;
  expiresAt: number;
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
  const scheme = input.headers.get("X-Bridge-Device-Scheme") || "";
  const keyId = input.headers.get("X-Bridge-Device-Key") || "";
  const nonce = input.headers.get("X-Bridge-Device-Nonce") || "";
  const issuedAt = Number(input.headers.get("X-Bridge-Device-Time"));
  const signature = decodeBase64Url(input.headers.get("X-Bridge-Device-Signature") || "", 64);
  if (scheme !== DAEMON_PREFLIGHT_SCHEME || !signature) return null;
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > DAEMON_PREFLIGHT_TTL_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce)) return null;
  let publicJwk: JsonWebKey;
  try { publicJwk = parsePublicJwk(input.publicKeyJson); } catch { return null; }
  if (!(await safeEqual(keyId, await publicKeyId(publicJwk)))) return null;
  let transcript: string;
  try {
    transcript = daemonPreflightTranscript({
      workerOrigin: input.workerOrigin,
      server: input.server,
      version: input.version,
      nonce,
      issuedAt,
    });
  } catch {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(transcript),
    );
    return valid ? { nonce, expiresAt: issuedAt + DAEMON_PREFLIGHT_TTL_SECONDS } : null;
  } catch {
    return null;
  }
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
  now?: number;
}): Promise<boolean> {
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  if (now < input.challenge.issuedAt - 5 || now > input.challenge.expiresAt) return false;
  if (!input.authentication || typeof input.authentication !== "object" || Array.isArray(input.authentication)) return false;
  const auth = input.authentication as Record<string, unknown>;
  if (auth.scheme !== DAEMON_AUTH_SCHEME) return false;
  if (!(await safeEqual(String(auth.challenge || ""), input.challenge.challenge))) return false;
  if (Number(auth.issued_at) !== input.challenge.issuedAt) return false;
  const signature = decodeBase64Url(String(auth.signature || ""), 64);
  if (!signature) return false;
  let publicJwk: JsonWebKey;
  try { publicJwk = parsePublicJwk(input.publicKeyJson); } catch { return false; }
  const expectedKeyId = await publicKeyId(publicJwk);
  if (!(await safeEqual(String(auth.key_id || ""), expectedKeyId))) return false;
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
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(transcript),
    );
  } catch {
    return false;
  }
}

function parsePublicJwk(value: string): JsonWebKey {
  const parsed = JSON.parse(value) as JsonWebKey;
  if (!parsed || parsed.kty !== "EC" || parsed.crv !== "P-256") throw new Error("invalid device public key");
  if (typeof parsed.x !== "string" || typeof parsed.y !== "string" || parsed.d !== undefined) throw new Error("invalid device public key");
  return { kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y, ext: true, key_ops: ["verify"] };
}

async function publicKeyId(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `device_${base64Url(new Uint8Array(digest)).slice(0, 32)}`;
}

function decodeBase64Url(value: string, expectedBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(normalized + padding);
    if (binary.length !== expectedBytes) return null;
    const bytes = new Uint8Array(expectedBytes);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
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
