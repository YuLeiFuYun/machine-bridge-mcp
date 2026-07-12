import process from "node:process";
import os from "node:os";

const COLORS = {
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const MAX_LOG_MESSAGE_CHARS = 2048;
const MAX_LOG_FIELD_CHARS = 4096;
const MAX_LOG_ARRAY_ITEMS = 32;
const MAX_LOG_OBJECT_KEYS = 48;
const LEVEL_RANK = Object.freeze({ debug: 10, info: 20, success: 20, warn: 30, error: 40 });
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const LOCAL_PATH_KEY = /(path|paths|cwd|workspace|directory|(?:^|[_-])dir(?:$|[_-])|root|home)/i;
const SECRET_VALUE = /\b(?:mcp_password|daemon_secret|token_version|mcp_at|mcp_code)_[A-Za-z0-9_-]+\b/g;
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
const HOME_PATHS = [...new Set([process.env.HOME, process.env.USERPROFILE, safeHomeDirectory()].filter(value => typeof value === "string" && value.length > 1))]
  .sort((left, right) => right.length - left.length);

export function createLogger(options = {}) {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose);
  const minimumLevel = normalizeLogLevel(options.level || (quiet ? "error" : verbose ? "debug" : "info"));
  const component = sanitizeLogText(options.component ? String(options.component) : "cli", 128);
  const useColor = shouldUseColor(options);
  const stdout = options.stderrOnly ? process.stderr : process.stdout;

  const write = (stream, level, label, color, message, fields) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
    const prefix = useColor ? `${color}${label}${COLORS.reset}` : label;
    const suffix = formatFields(fields);
    stream.write(`${prefix} ${component}: ${sanitizeLogText(message, MAX_LOG_MESSAGE_CHARS)}${suffix}\n`);
  };

  return {
    verbose: minimumLevel === "debug",
    level: minimumLevel,
    child(childComponent) {
      return createLogger({ ...options, component: childComponent });
    },
    info(message, fields) { write(stdout, "info", "[info]", COLORS.blue, message, fields); },
    success(message, fields) { write(stdout, "success", "[ok]", COLORS.green, message, fields); },
    warn(message, fields) { write(process.stderr, "warn", "[warn]", COLORS.yellow, message, fields); },
    error(message, fields) { write(process.stderr, "error", "[error]", COLORS.red, message, fields); },
    debug(message, fields) { write(process.stderr, "debug", "[debug]", COLORS.gray, message, fields); },
    plain(message = "") { if (!quiet) process.stdout.write(`${String(message)}\n`); },
    safePlain(message = "") { if (!quiet) process.stdout.write(`${sanitizeLogText(message, MAX_LOG_MESSAGE_CHARS)}\n`); },
    json(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); },
  };
}

export function normalizeLogLevel(value = "info") {
  const level = String(value || "info").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, level) || level === "success") {
    throw new Error("log level must be one of: error, warn, info, debug");
  }
  return level;
}


export function classifyOperationalError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/cancel/i.test(message)) return "cancelled";
  if (/timed out/i.test(message)) return "timeout";
  if (/unauthorized|forbidden|authentication|\b401\b|\b403\b/i.test(message)) return "authentication_failed";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|network|websocket|TLS|SSL/i.test(message)) return "network_error";
  if (/outside the configured workspace/i.test(message)) return "path_boundary";
  if (/disabled|requires .* mode/i.test(message)) return "policy_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/maximum|exceeds|max_bytes|too many/i.test(message)) return "limit_exceeded";
  if (/invalid|must|requires|ambiguous|mismatch/i.test(message)) return "invalid_request";
  return "execution_failed";
}

export function formatFields(fields) {
  try {
    if (!fields || typeof fields !== "object" || !Object.keys(fields).length) return "";
    const sanitized = sanitizeLogValue(fields);
    const json = JSON.stringify(sanitized);
    if (json.length <= MAX_LOG_FIELD_CHARS) return ` ${json}`;
    return ` ${JSON.stringify({
      fields_truncated: true,
      field_names: Object.keys(fields).slice(0, MAX_LOG_OBJECT_KEYS),
    })}`;
  } catch {
    return ' {"fields_unavailable":true}';
  }
}

function sanitizeLogValue(value, key = "", seen = new WeakSet(), depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (LOCAL_PATH_KEY.test(key)) return "<local-path>";
  if (value instanceof Error) return sanitizeLogText(value.message || value.name);
  if (typeof value === "string") return sanitizeLogText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "<max-depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_LOG_ARRAY_ITEMS).map(item => sanitizeLogValue(item, "", seen, depth + 1));
  const out = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS)) {
    out[childKey] = sanitizeLogValue(childValue, childKey, seen, depth + 1);
  }
  return out;
}

export function sanitizeLogText(value, maxChars = MAX_LOG_MESSAGE_CHARS) {
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
  for (const home of HOME_PATHS) sanitized = sanitized.split(home).join("<home>");
  sanitized = sanitized
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+(?=\/|$)/g, "<home>")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'<>]+(?=\\|$)/g, "<home>")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\r\n\t]/g, match => match === "\t" ? "\\t" : "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
  if (!Number.isFinite(Number(maxChars)) || Number(maxChars) <= 0) return "";
  const limit = Math.max(16, Number(maxChars));
  return sanitized.length > limit ? `${sanitized.slice(0, limit - 1)}…` : sanitized;
}

function safeHomeDirectory() {
  try { return os.homedir(); } catch { return ""; }
}

function shouldUseColor(options) {
  if (options.color === false || process.env.NO_COLOR) return false;
  if (options.color === true) return true;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}
