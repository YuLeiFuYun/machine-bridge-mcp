export const DEVICE_SESSION_CERTIFICATE_SCHEME: "device-session-certificate-v1";
export const DEVICE_SESSION_MAX_LIFETIME_SECONDS: number;

export function deviceSessionCertificateTranscript(input?: {
  workerOrigin?: unknown;
  server?: unknown;
  version?: unknown;
  rootKeyId?: unknown;
  publicJwk?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
  nonce?: unknown;
}): string;

export function canonicalPublicJwk(value: unknown): {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};
