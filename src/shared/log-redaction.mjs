import { sensitiveValuePattern } from "./sensitive-value-patterns.mjs";

const SECRET_VALUE = /\b(?:account_admin|daemon_secret|token_version|mcp_family|mcp_client|acct)_[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*(?![A-Za-z0-9._~+\/-=])/gi;
const EMAIL_VALUE = sensitiveValuePattern("emailAddress", "gi");
const AWS_ACCESS_KEY = sensitiveValuePattern("awsAccessKey");
const GITHUB_TOKEN = sensitiveValuePattern("githubAccessToken");
const GITLAB_TOKEN = sensitiveValuePattern("gitlabAccessToken");
const NPM_TOKEN = sensitiveValuePattern("npmAccessToken");
const SLACK_TOKEN = sensitiveValuePattern("slackAccessToken");
const GOOGLE_API_KEY = sensitiveValuePattern("googleApiKey");
const PAYMENT_API_KEY = sensitiveValuePattern("livePaymentApiKey");
const MACHINE_BRIDGE_CREDENTIAL = sensitiveValuePattern("machineBridgeCredential");
const JWT_VALUE = sensitiveValuePattern("jwtLikeBearerToken");
const URL_CREDENTIALS = sensitiveValuePattern("credentialUrl", "gi");
const NPM_CLI_AUTH_CHALLENGE = /(https?:\/\/[^\s"'<>]*\/auth\/cli\/)[^?&#\s"'<>]+/gi;
const SENSITIVE_URL_PARAMETER = /([?&#](?:access_token|refresh_token|token|code|state|auth|authid|session|sessionid|otp|verifier|proof|credential|client_secret|api[_-]?key|private[_-]?key)=)[^&#\s"'<>]*/gi;
const API_SECRET = sensitiveValuePattern("apiSecretToken");
const PRIVATE_KEY_HEADER = sensitiveValuePattern("privateKeyHeader");
const SENSITIVE_FIELD_NAME = /(?:authorization|cookie|password|passwd|secret|token|verifier|proof|credential|(?:account|client|family)[._-]?id|(?:api|private|access|signing)[._-]?key|(?:^|[._-])key(?:$|[._-]))/i;

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
    .replace(MACHINE_BRIDGE_CREDENTIAL, "<redacted-secret>")
    .replace(JWT_VALUE, "<redacted-bearer-token>")
    .replace(URL_CREDENTIALS, "<redacted-credential-url>")
    .replace(NPM_CLI_AUTH_CHALLENGE, "$1<redacted-challenge>")
    .replace(SENSITIVE_URL_PARAMETER, "$1<redacted>")
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
