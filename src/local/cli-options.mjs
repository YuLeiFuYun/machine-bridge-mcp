import { normalizeLogLevel } from "./log.mjs";

const BOOLEAN_OPTIONS = new Set([
  "help", "version", "quiet", "json", "verbose", "rotateSecrets", "forceWorker",
  "daemonOnly", "noAutostart", "noPrintCredentials", "printMcpCredentials",
  "printCredentials", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  "yes", "keepWorker", "allowInsecurePermissions", "showPaths",
]);
const VALUE_OPTIONS = new Set([
  "workspace", "stateDir", "workerName", "profile", "execMode", "client", "logLevel", "logFormat",
]);

const LOG_FORMATS = new Set(["text", "json"]);

const COMMAND_OPTIONS = {
  start: new Set([
    "workspace", "stateDir", "workerName", "quiet", "json", "verbose", "logLevel", "logFormat", "rotateSecrets", "forceWorker",
    "daemonOnly", "noAutostart", "noPrintCredentials", "printMcpCredentials", "printCredentials",
    "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  ]),
  stdio: new Set(["workspace", "stateDir", "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths", "verbose", "quiet", "logLevel", "logFormat"]),
  "client-config": new Set(["workspace", "stateDir", "profile", "client", "json"]),
  status: new Set(["workspace", "stateDir"]),
  doctor: new Set(["workspace", "stateDir"]),
  "full-test": new Set(["workspace", "stateDir", "json"]),
  "rotate-secrets": new Set(["workspace", "stateDir", "workerName", "noPrintCredentials", "printMcpCredentials", "printCredentials", "quiet"]),
  workspace: new Set(["workspace", "stateDir"]),
  service: new Set(["workspace", "stateDir", "quiet"]),
  autostart: new Set(["workspace", "stateDir", "quiet"]),
  resource: new Set(["workspace", "stateDir", "allowInsecurePermissions", "showPaths", "json"]),
  browser: new Set(["workspace", "stateDir", "json"]),
  job: new Set(["workspace", "stateDir", "json", "yes"]),
  uninstall: new Set(["stateDir", "keepWorker", "yes"]),
};

const SINGLE_WORKSPACE_POSITIONAL_COMMANDS = new Set(["start", "stdio", "status", "doctor", "full-test", "rotate-secrets"]);
const STATIC_POSITIONAL_RULES = Object.freeze({
  "client-config": Object.freeze({ max: 1, tooMany: "client-config accepts at most one positional client name" }),
  uninstall: Object.freeze({ max: 0, tooMany: "uninstall does not accept positional arguments" }),
});
const RESOURCE_POSITIONAL_LIMITS = Object.freeze({ add: 3, "generate-ssh-key": 3, remove: 2, check: 2 });
const JOB_POSITIONAL_LIMITS = Object.freeze({ read: 2, inspect: 2, cancel: 2, approve: 2, submit: 2 });
const ACTION_POSITIONAL_RULES = Object.freeze({
  workspace(args) {
    const action = String(args._[0] || "show");
    return { max: action === "set" || action === "select" ? 2 : 1, tooMany: `workspace ${action} received too many positional arguments`, workspaceConflictAfter: 1 };
  },
  service(args) {
    const action = String(args._[0] || "status");
    return { max: ["install", "status", "stop", "uninstall", "remove"].includes(action) ? 2 : 1, tooMany: `service ${action} received too many positional arguments`, workspaceConflictAfter: 1 };
  },
  autostart(args) { return ACTION_POSITIONAL_RULES.service(args); },
  resource(args) {
    const action = String(args._[0] || "list");
    return { max: RESOURCE_POSITIONAL_LIMITS[action] ?? 1, tooMany: `resource ${action} received too many positional arguments` };
  },
  browser(args) {
    const action = String(args._[0] || "status");
    return { max: 1, tooMany: `browser ${action} received too many positional arguments` };
  },
  job(args) {
    const action = String(args._[0] || "list");
    return { max: JOB_POSITIONAL_LIMITS[action] ?? 1, tooMany: `job ${action} received too many positional arguments` };
  },
});

export function normalizeCommand(argv) {
  if (!argv.length || argv[0].startsWith("--")) return ["start", argv];
  return [argv[0], argv.slice(1)];
}

export function parseArgs(argv) {
  const out = { _: [] };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (positionalOnly || raw === "-" || !raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    if (raw === "--") {
      positionalOnly = true;
      continue;
    }
    const separator = raw.indexOf("=");
    const rawKey = raw.slice(2, separator >= 0 ? separator : undefined);
    if (!rawKey) throw new Error("invalid empty option");
    const key = toCamel(rawKey);
    if (!BOOLEAN_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${rawKey}`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`Duplicate option: --${rawKey}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      out[key] = separator >= 0 ? parseBooleanOption(raw.slice(separator + 1), rawKey) : true;
      continue;
    }
    const value = separator >= 0 ? raw.slice(separator + 1) : argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Option --${rawKey} requires a value`);
    out[key] = value;
  }
  return out;
}

export function validateCommandOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || key === "version") continue;
    if (!allowed.has(key)) throw new Error(`Option --${toKebab(key)} is not valid for ${command}`);
  }
}

export function validateLoggingOptions(args = {}) {
  if (args.quiet && args.verbose) throw new Error("--quiet and --verbose cannot be used together");
  if (args.logLevel !== undefined && (args.quiet || args.verbose)) throw new Error("--log-level cannot be combined with --quiet or --verbose");
  if (args.logLevel !== undefined) normalizeLogLevel(args.logLevel);
  if (args.logFormat !== undefined && !LOG_FORMATS.has(String(args.logFormat).toLowerCase())) throw new Error("--log-format must be text or json");
}

export function validatePositionals(command, args) {
  const rule = positionalRule(command, args);
  if (!rule) return;
  if (args._.length > rule.max) throw new Error(rule.tooMany);
  if (args.workspace && Number.isInteger(rule.workspaceConflictAfter) && args._.length > rule.workspaceConflictAfter) {
    throw new Error("workspace path was provided both positionally and with --workspace");
  }
}

export function effectiveLogLevel(args = {}) {
  if (args.logLevel !== undefined) return normalizeLogLevel(args.logLevel);
  if (args.quiet) return "error";
  if (args.verbose) return "debug";
  return "info";
}

export function effectiveLogFormat(args = {}) {
  return String(args.logFormat || "text").toLowerCase();
}

function positionalRule(command, args) {
  if (SINGLE_WORKSPACE_POSITIONAL_COMMANDS.has(command)) {
    return { max: 1, tooMany: `${command} accepts at most one positional workspace path`, workspaceConflictAfter: 0 };
  }
  if (STATIC_POSITIONAL_RULES[command]) return STATIC_POSITIONAL_RULES[command];
  return ACTION_POSITIONAL_RULES[command]?.(args) || null;
}
function parseBooleanOption(value, key) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Option --${key} expects true or false when using =`);
}
function toCamel(key) { return key.replace(/-([a-z])/g, (_, character) => character.toUpperCase()); }
function toKebab(value) { return String(value).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`); }
