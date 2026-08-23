const SECRET_VALUE = /\b(?:account_admin|account_password|daemon_secret|token_version|mcp_at|mcp_code)_[A-Za-z0-9_-]+\b/g;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{30,}\b/g;
const SLACK_TOKEN = /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g;
const GOOGLE_API_KEY = /\bAIza[A-Za-z0-9_-]{30,}\b/g;
const PAYMENT_API_KEY = /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIALS = /https?:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@[^\s/"'<>]+/gi;
const API_SECRET = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g;
const PRIVATE_KEY_HEADER = /-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g;
const SENSITIVE_FIELD_NAME = /(?:authorization|cookie|password|passwd|secret|token|verifier|proof|credential|(?:api|private|access|signing)[._-]?key|(?:^|[._-])key(?:$|[._-]))/i;

export function isSensitiveLogFieldName(value) {
  let name;
  try { name = String(value ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2"); }
  catch { return true; }
  return SENSITIVE_FIELD_NAME.test(name);
}

export function sanitizePortableLogText(value, options = {}) {
  let raw;
  try { raw = String(value ?? ""); } catch { raw = "<unprintable>"; }
  let sanitized = raw
    .replace(SECRET_VALUE, "<redacted-secret>")
    .replace(BEARER_VALUE, "Bearer <redacted>")
    .replace(AWS_ACCESS_KEY, "<redacted-cloud-key>")
    .replace(GITHUB_TOKEN, "<redacted-access-token>")
    .replace(GITLAB_TOKEN, "<redacted-access-token>")
    .replace(NPM_TOKEN, "<redacted-access-token>")
    .replace(SLACK_TOKEN, "<redacted-access-token>")
    .replace(GOOGLE_API_KEY, "<redacted-cloud-key>")
    .replace(PAYMENT_API_KEY, "<redacted-api-secret>")
    .replace(JWT_VALUE, "<redacted-bearer-token>")
    .replace(URL_CREDENTIALS, "<redacted-credential-url>")
    .replace(API_SECRET, "<redacted-api-secret>")
    .replace(PRIVATE_KEY_HEADER, "<redacted-private-key-header>")
    .replace(EMAIL_VALUE, "<redacted-email>");

  const homePaths = Array.isArray(options.homePaths) ? options.homePaths : [];
  for (const home of [...new Set(homePaths.filter(item => typeof item === "string" && item.length > 1))]
    .sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(home).join("<home>");
  }
  sanitized = sanitized
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+(?=\/|$)/g, "<home>")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'<>]+(?=\\|$)/g, "<home>")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\r\n\t]/g, match => match === "\t" ? "\\t" : "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");

  const numericLimit = Number(options.maxChars);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return "";
  const limit = Math.max(16, numericLimit);
  return sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
}
