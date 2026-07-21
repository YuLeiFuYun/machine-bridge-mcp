export const ADMIN_AUTH_SCHEME: "hmac-sha256-v1";
export const ADMIN_AUTH_TTL_SECONDS: number;
export function adminAuthTranscript(input: {
  origin: unknown;
  method: unknown;
  pathname: unknown;
  bodyHash: unknown;
  issuedAt: unknown;
  nonce: unknown;
}): string;
