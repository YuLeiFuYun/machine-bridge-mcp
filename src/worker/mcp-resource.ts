export const NATIVE_MCP_PATH = "/mcp";
export const GEMINI_MCP_PATH = "/mcp/gemini";
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export type McpResourcePath = typeof NATIVE_MCP_PATH | typeof GEMINI_MCP_PATH;

export function isMcpResourcePath(path: string): path is McpResourcePath {
  return path === NATIVE_MCP_PATH || path === GEMINI_MCP_PATH;
}

export function isMcpOAuthResource(base: string, resource: string): boolean {
  return resource === base + NATIVE_MCP_PATH || resource === base + GEMINI_MCP_PATH;
}

const GEMINI_REDIRECT_ORIGINS = new Set([
  "https://oauth-redirect.googleusercontent.com",
  "https://oauth-redirect-sandbox.googleusercontent.com",
  "https://oauth-redirect-test.googleusercontent.com",
]);

export function isGeminiRedirectOrigin(origin: string): boolean {
  return GEMINI_REDIRECT_ORIGINS.has(origin);
}

export function defaultMcpOAuthResource(base: string, registeredRedirectUri: string): string {
  const redirect = new URL(registeredRedirectUri);
  const gemini = isGeminiRedirectOrigin(redirect.origin) && /^\/(?:r|a)\/.+/.test(redirect.pathname);
  return base + (gemini ? GEMINI_MCP_PATH : NATIVE_MCP_PATH);
}

export function matchesMcpOAuthResource(base: string, issued: string, requested: unknown): boolean {
  return isMcpOAuthResource(base, issued) && (requested === undefined || requested === issued);
}
