import { createHash, randomBytes } from "node:crypto";
import { DAEMON_HTTP_RELAY_SCHEME, daemonHttpRelayTranscript } from "../shared/daemon-auth.mjs";
import { encodeDeviceSessionCertificate, signWithDeviceSessionIdentity, validateDeviceSessionIdentity } from "./device-identity.mjs";

const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

export function createDaemonHttpRelayHeaders(identity, workerOrigin, server, version, body, now = Date.now()) {
  validateDeviceSessionIdentity(identity, now);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("daemon HTTP relay timestamp is invalid");
  const nonce = randomBytes(24).toString("base64url");
  const bodySha256 = createHash("sha256").update(body).digest("base64url");
  const signature = signWithDeviceSessionIdentity(identity, daemonHttpRelayTranscript({
    workerOrigin, server, version, nonce, issuedAt, bodySha256,
  }));
  return {
    "content-type": "application/json; charset=utf-8",
    "X-Bridge-Device-Scheme": DAEMON_HTTP_RELAY_SCHEME,
    "X-Bridge-Device-Key": identity.keyId,
    "X-Bridge-Device-Nonce": nonce,
    "X-Bridge-Device-Time": String(issuedAt),
    "X-Bridge-Body-SHA256": bodySha256,
    "X-Bridge-Device-Signature": signature,
    [SESSION_CERTIFICATE_HEADER]: encodeDeviceSessionCertificate(identity),
  };
}
