import type { AuthorizedToken } from "./access.ts";
import type { OAuthController } from "./oauth-controller.ts";
import { consumeDpopProof, verifyDpopProof } from "./dpop.ts";
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
  requiredScope: string;
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
    dpopValid = Boolean(proof && await consumeDpopProof(input.storage, proof));
  } else if (authorized && access.scheme !== "bearer") {
    dpopValid = false;
  }
  if (authorized && dpopValid) return { authorized };

  await discardRequestBody(input.request, input.bodyLimitBytes);
  const scheme = authorized?.dpopJkt ? "DPoP" : "Bearer";
  const requiredScope = oauthChallengeScope(input.requiredScope);
  return {
    response: new Response(authorized?.dpopJkt ? "Valid DPoP proof required" : "OAuth bearer token required", {
      status: 401,
      headers: {
        "WWW-Authenticate": `${scheme} resource_metadata="${input.base}/.well-known/oauth-protected-resource/mcp", scope="${requiredScope}"`,
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    }),
  };
}

function oauthChallengeScope(value: string): string {
  const scope = String(value || "");
  if (!scope || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) {
    throw new Error("OAuth challenge scope is invalid");
  }
  return scope;
}
