import type { OAuthControllerEnv } from "./oauth-controller.ts";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface BridgeEnv extends OAuthControllerEnv {
  BRIDGE: DurableObjectNamespace;
  DAEMON_DEVICE_PUBLIC_KEY: string;
  OAUTH_TOKEN_VERSION: string;
  MBM_WORKER_MAX_BODY_BYTES?: string;
  MBM_ALLOWED_ORIGINS?: string;
  STATEFUL_RATE_LIMITER: RateLimit;
}

export function workerBodyLimitBytes(configured: string | undefined): number {
  const parsed = Number.parseInt(configured ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(parsed, MAX_BODY_BYTES);
}
