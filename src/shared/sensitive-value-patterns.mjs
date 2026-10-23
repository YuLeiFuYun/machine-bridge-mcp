// @ts-check
const SOURCES = /** @type {Record<string, string>} */ (Object.freeze({
  privateKeyHeader: String.raw`-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----`,
  awsAccessKey: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
  githubAccessToken: String.raw`\bgh[pousr]_[A-Za-z0-9_]{30,}(?![A-Za-z0-9_])`,
  gitlabAccessToken: String.raw`\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])`,
  npmAccessToken: String.raw`\bnpm_[A-Za-z0-9]{30,}(?![A-Za-z0-9])`,
  slackAccessToken: String.raw`\bxox[aboprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])`,
  googleApiKey: String.raw`\bAIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])`,
  livePaymentApiKey: String.raw`\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}(?![A-Za-z0-9])`,
  machineBridgeCredential: String.raw`\b(?:account_password|mcp_at|mcp_rt|mcp_code|mcp_jr|mcp_jc)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`,
  apiSecretToken: String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])`,
  jwtLikeBearerToken: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])`,
  credentialUrl: String.raw`https?:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@([^\s/"'<>]+)`,
  emailAddress: String.raw`\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b`,
}));

/** @param {string} name @param {string} [flags] @returns {RegExp} */
export function sensitiveValuePattern(name, flags = "g") {
  if (typeof name !== "string" || !Object.hasOwn(SOURCES, name)) throw new TypeError("unknown sensitive-value pattern");
  const source = SOURCES[name];
  return new RegExp(source, flags);
}

const PRIVATE_KEY_BLOCK = /-----BEGIN\s+((?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED)\s+)?PRIVATE\s+KEY)-----[\s\S]*?(?:-----END\s+\1-----|$)/g;
const HEX_SHELLCODE = /(?:\\x[0-9a-fA-F]{2}){8,}/g;
const REVERSE_SHELL = /\b(?:bash|sh|zsh)\s+-i\s+>&?\s*\/dev\/tcp\/[^\s'"]+/gi;
const SHADOW_PASSWORD_HASH = /\b[a-zA-Z0-9_-]+:\$[156y]\$[A-Za-z0-9./]+\$[A-Za-z0-9./]{16,}/g;

/**
 * Universal sensitive token redaction across all MCP projections.
 * @param {unknown} text
 * @returns {unknown}
 */
export function redactSensitiveText(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(PRIVATE_KEY_BLOCK, "<redacted:private_key>")
    .replace(sensitiveValuePattern("privateKeyHeader"), "<redacted:private_key_header>")
    .replace(sensitiveValuePattern("awsAccessKey"), "<redacted:aws_key>")
    .replace(sensitiveValuePattern("githubAccessToken"), "<redacted:github_token>")
    .replace(sensitiveValuePattern("gitlabAccessToken"), "<redacted:gitlab_token>")
    .replace(sensitiveValuePattern("npmAccessToken"), "<redacted:npm_token>")
    .replace(sensitiveValuePattern("slackAccessToken"), "<redacted:slack_token>")
    .replace(sensitiveValuePattern("googleApiKey"), "<redacted:google_api_key>")
    .replace(sensitiveValuePattern("livePaymentApiKey"), "<redacted:payment_api_key>")
    .replace(sensitiveValuePattern("machineBridgeCredential"), "<redacted:credential>")
    .replace(sensitiveValuePattern("jwtLikeBearerToken"), "<redacted:jwt_token>")
    .replace(sensitiveValuePattern("apiSecretToken"), "<redacted:api_secret>")
    .replace(HEX_SHELLCODE, "<redacted:binary_payload>")
    .replace(REVERSE_SHELL, "<redacted:reverse_shell>")
    .replace(SHADOW_PASSWORD_HASH, "<redacted:password_hash>");
}
