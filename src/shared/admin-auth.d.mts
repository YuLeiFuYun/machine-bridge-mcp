export const ADMIN_AUTH_SCHEME: "device-admin-signature-v1";
export const ADMIN_AUTH_TTL_SECONDS: number;
export function adminAuthTranscript(input: {
  origin: unknown;
  method: unknown;
  pathname: unknown;
  bodyHash: unknown;
  keyId: unknown;
  issuedAt: unknown;
  nonce: unknown;
}): string;
