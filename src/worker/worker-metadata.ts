import serverMetadata from "../shared/server-metadata.json" with { type: "json" };

export type WorkerIdentity = { server: string; version: string };

export function mcpMetadata(base: string, identity: WorkerIdentity): Record<string, unknown> {
  return {
    name: identity.server,
    version: identity.version,
    protocolVersion: String(serverMetadata.protocolVersion),
    protocolVersions: serverMetadata.supportedProtocolVersions.map((value) => String(value)),
    protocolEras: {
      modern: serverMetadata.modernProtocolVersions.map((value) => String(value)),
      legacy: serverMetadata.legacyProtocolVersions.map((value) => String(value)),
    },
    transport: {
      type: "streamable-http",
      url: `${base}/mcp`,
      modern: { methods: ["POST"], protocolSessions: false, resumableSse: false },
      legacy: { methods: ["GET", "POST"], protocolSessions: true, resumableSse: true },
    },
    auth: { type: "oauth", authorization_servers: [base] },
  };
}

export function authorizationServerMetadata(base: string, serverName: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [serverName, "offline_access"],
  };
}

export function protectedResourceMetadata(base: string, serverName: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [serverName, "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: serverName,
  };
}
