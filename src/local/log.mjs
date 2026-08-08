import process from "node:process";
import os from "node:os";
import { errorCode } from "./errors.mjs";
import { sanitizePortableLogText } from "../shared/log-redaction.mjs";

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
const HOME_PATHS = [...new Set([process.env.HOME, process.env.USERPROFILE, safeHomeDirectory()].filter(value => typeof value === "string" && value.length > 1))]
  .sort((left, right) => right.length - left.length);

export function createLogger(options = {}) {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose);
  const minimumLevel = normalizeLogLevel(options.level || (quiet ? "error" : verbose ? "debug" : "info"));
  const component = sanitizeLogText(options.component ? String(options.component) : "cli", 128);
  const useColor = shouldUseColor(options);
  const stderr = options.stderr || process.stderr;
  const stdout = options.stderrOnly ? stderr : (options.stdout || process.stdout);

  const write = (stream, level, label, color, message, fields) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
    const sanitizedMessage = sanitizeLogText(message, MAX_LOG_MESSAGE_CHARS);
    if (options.format === "json") {
      const entry = sanitizeLogValue({
        ...(fields && typeof fields === "object" ? fields : {}),
        timestamp: new Date().toISOString(),
        level: level === "success" ? "info" : level,
        component,
        message: sanitizedMessage,
      });
      stream.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    const prefix = useColor ? `${color}${label}${COLORS.reset}` : label;
    const suffix = formatFields(fields);
    stream.write(`${prefix} ${component}: ${sanitizedMessage}${suffix}\n`);
  };

  const event = (level, name, fields = {}, message = "") => {
    const normalizedLevel = normalizeEventLevel(level);
    const eventName = sanitizeEventName(name);
    const payload = { ...fields, event: eventName };
    const humanMessage = message || humanizeEventName(eventName);
    if (options.format === "json") {
      if (LEVEL_RANK[normalizedLevel] < LEVEL_RANK[minimumLevel]) return;
      const entry = sanitizeLogValue({
        ...payload,
        timestamp: new Date().toISOString(),
        level: normalizedLevel === "success" ? "info" : normalizedLevel,
        component,
        message: sanitizeLogText(humanMessage, MAX_LOG_MESSAGE_CHARS),
      });
      const target = normalizedLevel === "info" || normalizedLevel === "success" ? stdout : stderr;
      target.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    const methods = {
      debug: [stderr, "[debug]", COLORS.gray],
      info: [stdout, "[info]", COLORS.blue],
      success: [stdout, "[ok]", COLORS.green],
      warn: [stderr, "[warn]", COLORS.yellow],
      error: [stderr, "[error]", COLORS.red],
    };
    const [stream, label, color] = methods[normalizedLevel];
    write(stream, normalizedLevel, label, color, humanMessage, fields);
  };

  return {
    verbose: minimumLevel === "debug",
    level: minimumLevel,
    format: options.format === "json" ? "json" : "text",
    child(childComponent) {
      return createLogger({ ...options, component: childComponent });
    },
    event,
    info(message, fields) { write(stdout, "info", "[info]", COLORS.blue, message, fields); },
    success(message, fields) { write(stdout, "success", "[ok]", COLORS.green, message, fields); },
    warn(message, fields) { write(stderr, "warn", "[warn]", COLORS.yellow, message, fields); },
    error(message, fields) { write(stderr, "error", "[error]", COLORS.red, message, fields); },
    debug(message, fields) { write(stderr, "debug", "[debug]", COLORS.gray, message, fields); },
    plain(message = "") { if (!quiet) stdout.write(`${String(message)}\n`); },
    safePlain(message = "") { if (!quiet) stdout.write(`${sanitizeLogText(message, MAX_LOG_MESSAGE_CHARS)}\n`); },
    json(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); },
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
  return errorCode(error);
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
  const out = Object.create(null);
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS)) {
    out[childKey] = sanitizeLogValue(childValue, childKey, seen, depth + 1);
  }
  return out;
}

export function sanitizeLogText(value, maxChars = MAX_LOG_MESSAGE_CHARS) {
  return sanitizePortableLogText(value, { maxChars, homePaths: HOME_PATHS });
}

function safeHomeDirectory() {
  try { return os.homedir(); } catch { return ""; }
}

function shouldUseColor(options) {
  if (options.color === false || process.env.NO_COLOR) return false;
  if (options.color === true) return true;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}

function normalizeEventLevel(value) {
  const level = String(value || "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level) ? level : "info";
}

function humanizeEventName(value) {
  const words = String(value || "event")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Event";
}

function sanitizeEventName(value) {
  const name = String(value || "event").toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 128);
  return name || "event";
}
