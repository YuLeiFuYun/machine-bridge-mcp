import { proxyMcpResponseStream } from "./mcp-response-proxy.ts";
import { sanitizeBridgeRequest } from "./mcp-stream-proxy-contract.ts";
import { respondWithoutDurableObject } from "./worker-static-routes.ts";
import { createThrottledEdgeLogger } from "./worker-edge-log.ts";
import { statefulRouteClass } from "./worker-rate-limit-key.ts";
import {
  admitGlobalStatefulRequest, admitStatefulRequest,
  durableObjectQuotaResponse,
  isDurableObjectQuotaError,
  outerWorkerErrorClass,
  workerGatewayErrorResponse,
} from "./worker-edge-guard.ts";

type OuterBridgeStub = { fetch(request: Request): Promise<Response> };
type OuterBridgeNamespace = { getByName(name: string): OuterBridgeStub };

export interface OuterWorkerEnv {
  BRIDGE: OuterBridgeNamespace;
  STATEFUL_GLOBAL_RATE_LIMITER: RateLimit;
  STATEFUL_RATE_LIMITER: RateLimit;
  MBM_ALLOWED_ORIGINS?: string;
}

const logOuterFetchFailure = createThrottledEdgeLogger();

// One bridge-specific Durable Object per deployment is the documented topology: it
// owns OAuth clients, tokens, the daemon registry, and pending calls as one
// consistency domain. A request-supplied workspace name must never select that
// object, because it is unauthenticated and would fork authoritative state.
const BRIDGE_OBJECT_NAME = "default";

export async function handleOuterWorkerFetch(
  request: Request,
  env: OuterWorkerEnv,
  ctx: ExecutionContext,
  identity: { server: string; version: string },
): Promise<Response> {
  const extraOrigins = env.MBM_ALLOWED_ORIGINS ?? "";
  const staticResponse = respondWithoutDurableObject(request, identity, extraOrigins);
  if (staticResponse) return staticResponse;

  try {
    const globallyLimited = await admitGlobalStatefulRequest(request, env.STATEFUL_GLOBAL_RATE_LIMITER, extraOrigins);
    if (globallyLimited) return globallyLimited;
    const limited = await admitStatefulRequest(request, env.STATEFUL_RATE_LIMITER, extraOrigins);
    if (limited) return limited;
    const stub = env.BRIDGE.getByName(BRIDGE_OBJECT_NAME);
    const streamed = await proxyMcpResponseStream({ request, bridge: stub, ctx });
    return streamed ?? await stub.fetch(sanitizeBridgeRequest(request));
  } catch (error) {
    if (isDurableObjectQuotaError(error)) return durableObjectQuotaResponse(request, extraOrigins);
    logOuterFetchFailure("error", "outer.fetch.failed", {
      route: statefulRouteClass(new URL(request.url).pathname),
      error_class: outerWorkerErrorClass(error),
    });
    return workerGatewayErrorResponse(request, extraOrigins);
  }
}
