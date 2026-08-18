export const DAEMON_AUTH_SCHEME: "device-signature-v1";
export const DAEMON_PREFLIGHT_SCHEME: "device-preflight-v1";
export const DAEMON_HTTP_RELAY_SCHEME: "device-http-relay-v1";
export const DAEMON_AUTH_CHALLENGE_TTL_SECONDS: number;
export const DAEMON_PREFLIGHT_TTL_SECONDS: number;
export const DAEMON_HTTP_RELAY_TTL_SECONDS: number;
export function daemonAuthTranscript(input: {
  challenge: unknown;
  workerOrigin: unknown;
  server: unknown;
  version: unknown;
  instanceId: unknown;
  issuedAt: unknown;
}): string;

export function daemonPreflightTranscript(input: {
  workerOrigin: unknown;
  server: unknown;
  version: unknown;
  nonce: unknown;
  issuedAt: unknown;
}): string;

export function daemonHttpRelayTranscript(input: {
  workerOrigin: unknown;
  server: unknown;
  version: unknown;
  nonce: unknown;
  issuedAt: unknown;
  bodySha256: unknown;
}): string;
