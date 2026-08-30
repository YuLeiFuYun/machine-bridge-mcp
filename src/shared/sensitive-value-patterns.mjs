const SOURCES = Object.freeze({
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
});

export function sensitiveValuePattern(name, flags = "g") {
  const source = SOURCES[String(name || "")];
  if (!source) throw new TypeError(`unknown sensitive-value pattern: ${name}`);
  return new RegExp(source, flags);
}
