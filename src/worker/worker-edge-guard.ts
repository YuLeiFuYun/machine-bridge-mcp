import { applyCors, baseUrl, json } from "./http.ts";
import { createThrottledEdgeLogger } from "./worker-edge-log.ts";
import { globalStatefulRateLimitKey, statefulRateLimitKey } from "./worker-rate-limit-key.ts";
export { statefulRateLimitKey } from "./worker-rate-limit-key.ts";

type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
const logLimiterFailure = createThrottledEdgeLogger();

export async function admitGlobalStatefulRequest(request: Request, limiter: RateLimiter, extraOrigins = ""): Promise<Response | null> {
  return admitRateLimit(request, limiter, globalStatefulRateLimitKey(request), extraOrigins);
}

export async function admitStatefulRequest(request: Request, limiter: RateLimiter, extraOrigins = ""): Promise<Response | null> {
  return admitRateLimit(request, limiter, await statefulRateLimitKey(request), extraOrigins);
}

async function admitRateLimit(request: Request, limiter: RateLimiter, key: string, extraOrigins: string): Promise<Response | null> {
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key });
  } catch {
    logLimiterFailure("warn", "stateful.rate_limiter.unavailable");
    return null;
  }
  if (result.success) return null;
  return applyCors(json({
    error: "rate_limit_exceeded",
    message: "The remote bridge is temporarily limiting stateful requests.",
    retryable: true,
  }, 429, { "retry-after": "60" }), request, baseUrl(request), extraOrigins);
}

export function isDurableObjectQuotaError(error: unknown): boolean {
  for (const current of boundedErrorChain(error)) {
    const message = current instanceof Error ? current.message : String(current ?? "");
    const code = typeof current === "object" && current !== null ? String((current as { code?: unknown }).code ?? "") : "";
    if (/Exceeded allowed volume of requests in Durable Objects free tier/i.test(message)) return true;
    if (/Durable Objects free tier/i.test(message) && /quota|limit|exceed|volume/i.test(message)) return true;
    if (code === "ERR_DURABLE_OBJECT_QUOTA_EXCEEDED") return true;
  }
  return false;
}

export function durableObjectQuotaResponse(request: Request, extraOrigins = ""): Response {
  return errorResponse(request, extraOrigins, 503, "durable_object_quota_exceeded",
    "Durable Objects free-tier capacity is exhausted until the daily UTC reset.", "3600");
}

export function workerGatewayErrorResponse(request: Request, extraOrigins = ""): Response {
  return errorResponse(request, extraOrigins, 502, "worker_gateway_error",
    "The remote bridge could not reach its durable state owner.", "1");
}

export function outerWorkerErrorClass(error: unknown): string {
  const parts: string[] = [];
  for (const current of boundedErrorChain(error)) {
    if (typeof current !== "object" || current === null) break;
    const name = String((current as { name?: unknown }).name ?? "");
    const code = String((current as { code?: unknown }).code ?? "");
    if (name) parts.push(name);
    if (code) parts.push(code);
  }
  return (parts.join(":") || "unknown").toLowerCase().replace(/[^a-z0-9._:-]/g, "_").slice(0, 160);
}

function errorResponse(request: Request, extraOrigins: string, status: number, error: string, message: string, retryAfter: string): Response {
  return applyCors(json({ error, message, retryable: true }, status, { "retry-after": retryAfter }),
    request, baseUrl(request), extraOrigins);
}

function boundedErrorChain(value: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = value;
  while (current !== undefined && chain.length < 8) {
    if (!isObjectLike(current)) {
      chain.push(current);
      break;
    }
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
