import {
  DEVICE_SESSION_CERTIFICATE_SCHEME,
  DEVICE_SESSION_MAX_LIFETIME_SECONDS,
  canonicalPublicJwk,
  deviceSessionCertificateTranscript,
} from "../shared/device-session-auth.mjs";
import { safeEqual } from "./oauth-state.ts";

const SESSION_CERTIFICATE_MAX_BYTES = 16 * 1024;

export interface VerifiedDeviceSessionCertificate {
  sessionPublicJwk: JsonWebKey;
  sessionPublicKeyJson: string;
  sessionKeyId: string;
  rootKeyId: string;
  issuedAt: number;
  expiresAt: number;
}

export async function verifyDeviceSessionCertificate(input: {
  encodedCertificate: string;
  rootPublicKeyJson: string;
  workerOrigin: string;
  server: string;
  version: string;
  now: number;
}): Promise<VerifiedDeviceSessionCertificate | null> {
  const bytes = decodeBase64Url(input.encodedCertificate);
  if (!bytes || bytes.byteLength > SESSION_CERTIFICATE_MAX_BYTES) return null;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.scheme !== DEVICE_SESSION_CERTIFICATE_SCHEME) return null;
  const issuedAt = Number(value.issued_at);
  const expiresAt = Number(value.expires_at);
  const nonce = String(value.nonce || "");
  const rootKeyId = String(value.root_key_id || "");
  const signature = decodeBase64Url(String(value.signature || ""), 64);
  if (!signature || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  if (issuedAt > input.now + 5 * 60 || expiresAt <= input.now) return null;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > DEVICE_SESSION_MAX_LIFETIME_SECONDS) return null;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce)) return null;
  let rootPublicJwk: JsonWebKey;
  let sessionPublicJwk: JsonWebKey;
  try {
    rootPublicJwk = parsePublicJwk(input.rootPublicKeyJson);
    sessionPublicJwk = parsePublicJwk(JSON.stringify(value.public_jwk));
  } catch {
    return null;
  }
  const expectedRootKeyId = await publicKeyId(rootPublicJwk);
  if (!(await safeEqual(rootKeyId, expectedRootKeyId))) return null;
  let transcript: string;
  try {
    transcript = deviceSessionCertificateTranscript({
      workerOrigin: input.workerOrigin,
      server: input.server,
      version: input.version,
      rootKeyId,
      publicJwk: sessionPublicJwk,
      issuedAt,
      expiresAt,
      nonce,
    });
  } catch {
    return null;
  }
  if (!(await verifyP256Signature(rootPublicJwk, transcript, signature))) return null;
  return {
    sessionPublicJwk,
    sessionPublicKeyJson: JSON.stringify(canonicalPublicJwk(sessionPublicJwk)),
    sessionKeyId: await publicKeyId(sessionPublicJwk),
    rootKeyId,
    issuedAt,
    expiresAt,
  };
}

export async function verifyP256Signature(publicJwk: JsonWebKey, transcript: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
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

export function parsePublicJwk(value: string): JsonWebKey {
  const parsed = JSON.parse(value) as JsonWebKey;
  const canonical = canonicalPublicJwk(parsed);
  return { ...canonical, ext: true, key_ops: ["verify"] };
}

export async function publicKeyId(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify(canonicalPublicJwk(jwk));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `device_${base64Url(new Uint8Array(digest)).slice(0, 32)}`;
}

export function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(normalized + padding);
    if (expectedBytes !== undefined && binary.length !== expectedBytes) return null;
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
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
