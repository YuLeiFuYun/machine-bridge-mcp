import {
  DAEMON_HTTP_RELAY_SCHEME, DAEMON_HTTP_RELAY_TTL_SECONDS, daemonHttpRelayTranscript,
} from "../shared/daemon-auth.mjs";
import { safeEqual } from "./oauth-state.ts";
import { consumeBoundedNonce } from "./nonce-store.ts";
import {
  decodeBase64Url, verifyDeviceSessionCertificate, verifyP256Signature,
} from "./device-session-verifier.ts";

const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

export async function verifyDaemonHttpRelayRequest(input: {
  storage: DurableObjectStorage;
  publicKeyJson: string;
  headers: Headers;
  body: Uint8Array;
  workerOrigin: string;
  server: string;
  version: string;
  now?: number;
}): Promise<boolean> {
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  const certificate = await verifyDeviceSessionCertificate({
    encodedCertificate: input.headers.get(SESSION_CERTIFICATE_HEADER) || "",
    rootPublicKeyJson: input.publicKeyJson,
    workerOrigin: input.workerOrigin,
    server: input.server,
    version: input.version,
    now,
  });
  if (!certificate) return false;
  const scheme = input.headers.get("X-Bridge-Device-Scheme") || "";
  const keyId = input.headers.get("X-Bridge-Device-Key") || "";
  const nonce = input.headers.get("X-Bridge-Device-Nonce") || "";
  const issuedAt = Number(input.headers.get("X-Bridge-Device-Time"));
  const claimedBodyHash = input.headers.get("X-Bridge-Body-SHA256") || "";
  const signature = decodeBase64Url(input.headers.get("X-Bridge-Device-Signature") || "", 64);
  if (scheme !== DAEMON_HTTP_RELAY_SCHEME || !signature || !/^[A-Za-z0-9_-]{43}$/.test(claimedBodyHash)) return false;
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > DAEMON_HTTP_RELAY_TTL_SECONDS) return false;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce) || !(await safeEqual(keyId, certificate.sessionKeyId))) return false;
  const digestInput = new Uint8Array(input.body.byteLength);
  digestInput.set(input.body);
  const actualBodyHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)));
  if (!(await safeEqual(claimedBodyHash, actualBodyHash))) return false;
  let transcript: string;
  try {
    transcript = daemonHttpRelayTranscript({
      workerOrigin: input.workerOrigin, server: input.server, version: input.version,
      nonce, issuedAt, bodySha256: claimedBodyHash,
    });
  } catch { return false; }
  if (!(await verifyP256Signature(certificate.sessionPublicJwk, transcript, signature))) return false;
  return consumeBoundedNonce(input.storage, {
    key: "daemon-http-relay-nonces", nonce, expiresAt: issuedAt + DAEMON_HTTP_RELAY_TTL_SECONDS, now,
    noncePattern: /^[A-Za-z0-9_-]{24,128}$/, maximum: 1024, maxFutureSeconds: DAEMON_HTTP_RELAY_TTL_SECONDS * 2,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
