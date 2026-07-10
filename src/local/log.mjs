import process from "node:process";

const COLORS = {
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const SECRET_VALUE = /\b(?:mcp_password|daemon_secret|token_version|mcp_at|mcp_code)_[A-Za-z0-9_-]+\b/g;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi;

export function createLogger(options = {}) {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose);
  const component = sanitizeLogText(options.component ? String(options.component) : "cli");
  const useColor = shouldUseColor(options);

  const write = (stream, level, label, color, message, fields) => {
    if (quiet && level !== "error") return;
    if (level === "debug" && !verbose) return;
    const prefix = useColor ? `${color}${label}${COLORS.reset}` : label;
    const suffix = formatFields(fields);
    stream.write(`${prefix} ${component}: ${sanitizeLogText(message)}${suffix}\n`);
  };

  return {
    child(childComponent) {
      return createLogger({ ...options, component: childComponent });
    },
    info(message, fields) { write(process.stdout, "info", "[info]", COLORS.blue, message, fields); },
    success(message, fields) { write(process.stdout, "success", "[ok]", COLORS.green, message, fields); },
    warn(message, fields) { write(process.stderr, "warn", "[warn]", COLORS.yellow, message, fields); },
    error(message, fields) { write(process.stderr, "error", "[error]", COLORS.red, message, fields); },
    debug(message, fields) { write(process.stderr, "debug", "[debug]", COLORS.gray, message, fields); },
    plain(message = "") { if (!quiet) process.stdout.write(`${String(message)}\n`); },
    json(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); },
  };
}

export function redactSecret(value) {
  return value ? "<redacted>" : "<empty>";
}

export function formatFields(fields) {
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) return "";
  return ` ${JSON.stringify(sanitizeLogValue(fields))}`;
}

export function sanitizeLogValue(value, key = "", seen = new WeakSet(), depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (value instanceof Error) return sanitizeLogText(value.message || value.name);
  if (typeof value === "string") return sanitizeLogText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "<max-depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeLogValue(item, "", seen, depth + 1));
  const out = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    out[childKey] = sanitizeLogValue(childValue, childKey, seen, depth + 1);
  }
  return out;
}

export function sanitizeLogText(value) {
  return String(value ?? "")
    .replace(SECRET_VALUE, "<redacted-secret>")
    .replace(BEARER_VALUE, "Bearer <redacted>")
    .replace(/[\r\n\t]/g, match => match === "\t" ? "\\t" : "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
}

function shouldUseColor(options) {
  if (options.color === false || process.env.NO_COLOR) return false;
  if (options.color === true) return true;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}
