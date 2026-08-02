import type { OAuthController, AuthorizedToken } from "./oauth-controller.ts";
import { consumeDpopProof, consumeDpopProofForInternalRetry, verifyDpopProof } from "./dpop.ts";
import { discardRequestBody, oauthAccessToken } from "./http.ts";

export type McpAccessResult =
  | { authorized: AuthorizedToken; response?: never }
  | { authorized?: never; response: Response };

export async function authorizeMcpRequest(input: {
  request: Request;
  base: string;
  oauth: OAuthController;
  storage: DurableObjectStorage;
  bodyLimitBytes: number;
  internalDpopRetryId?: string;
}): Promise<McpAccessResult> {
  const access = oauthAccessToken(input.request);
  const authorized = await input.oauth.verifyAccessToken(access.token, input.base);
  let dpopValid = true;
  if (authorized?.dpopJkt) {
    const proof = access.scheme === "dpop" ? await verifyDpopProof({
      request: input.request,
      expectedMethod: input.request.method,
      expectedUrl: input.request.url,
      accessToken: access.token,
      expectedJkt: authorized.dpopJkt,
    }) : null;
    dpopValid = Boolean(proof && (input.internalDpopRetryId
      ? await consumeDpopProofForInternalRetry(input.storage, proof, input.internalDpopRetryId)
      : await consumeDpopProof(input.storage, proof)));
  } else if (authorized && access.scheme !== "bearer") {
    dpopValid = false;
  }
  if (authorized && dpopValid) return { authorized };

  await discardRequestBody(input.request, input.bodyLimitBytes);
  const scheme = authorized?.dpopJkt ? "DPoP" : "Bearer";
  return {
    response: new Response(authorized?.dpopJkt ? "Valid DPoP proof required" : "OAuth bearer token required", {
      status: 401,
      headers: {
        "WWW-Authenticate": `${scheme} resource_metadata="${input.base}/.well-known/oauth-protected-resource/mcp"`,
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    }),
  };
}
