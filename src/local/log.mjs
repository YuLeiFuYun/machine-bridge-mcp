import process from "node:process";

const COLORS = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

export function createLogger(options = {}) {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose);
  const component = options.component ? String(options.component) : "cli";
  const useColor = shouldUseColor(options);

  const write = (stream, level, label, color, message, fields) => {
    if (quiet && level !== "error") return;
    if (level === "debug" && !verbose) return;
    const prefix = useColor ? `${color}${label}${COLORS.reset}` : label;
    const suffix = formatFields(fields);
    stream.write(`${prefix} ${component}: ${String(message)}${suffix}\n`);
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
  const text = String(value || "");
  if (!text) return "<empty>";
  if (text.length <= 12) return "<redacted>";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function formatFields(fields) {
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) return "";
  return ` ${JSON.stringify(fields, (_key, value) => {
    if (value instanceof Error) return value.message;
    return value;
  })}`;
}

function shouldUseColor(options) {
  if (options.color === false || process.env.NO_COLOR) return false;
  if (options.color === true) return true;
  return Boolean(process.stderr.isTTY || process.stdout.isTTY);
}
