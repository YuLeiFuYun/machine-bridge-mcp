import { realpathSync, statSync } from "node:fs";
import path, { delimiter, isAbsolute } from "node:path";

export function resolveNpmCli(options = {}) {
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const nodeExecutable = path.resolve(String(options.nodeExecutable || process.execPath));
  const nodeDirectory = path.dirname(nodeExecutable);
  const packageManagerPrefix = nodePackageManagerPrefix(nodeExecutable);
  const candidates = [
    options.npmCli,
    ...(options.allowLifecycleNpmCli === false ? [] : [env.npm_execpath]),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    packageManagerPrefix && path.join(packageManagerPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(options.allowFallbackLocations === false ? [] : [
      env.ProgramFiles && path.join(env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
      "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js",
    ]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(String(candidate))) continue;
    try {
      const canonical = realpathSync(String(candidate));
      const info = statSync(canonical);
      if (!info.isFile()) continue;
      if (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0) continue;
      return canonical;
    } catch {
      // Candidate discovery is bounded and failure of one conventional location is irrelevant.
    }
  }
  throw new Error("npm 12 CLI could not be located; install npm 12 alongside Node.js 26 and retry");
}

function nodePackageManagerPrefix(nodeExecutable) {
  const marker = `${path.sep}Cellar${path.sep}`;
  const index = nodeExecutable.indexOf(marker);
  return index > 0 ? nodeExecutable.slice(0, index) : "";
}
const LEVELS = ["info", "low", "moderate", "high", "critical"];

export function validateNpmAudit(report, exitCode = 0, label = "consumer") {
  const metadata = report?.metadata;
  const vulnerabilities = metadata?.vulnerabilities;
  if (!isRecord(report) || report.error !== undefined || !isRecord(metadata) || !isRecord(vulnerabilities)
    || ![...LEVELS, "total"].every(key => Object.hasOwn(vulnerabilities, key)
      && Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)) {
    throw new Error(`${label} npm audit metadata is incomplete`);
  }
  const total = LEVELS.reduce((sum, key) => sum + vulnerabilities[key], 0);
  if (!Number.isSafeInteger(total) || vulnerabilities.total !== total) throw new Error(`${label} npm audit total is inconsistent`);
  if (exitCode !== 0 || total !== 0) {
    throw new Error(`${label} production dependency audit failed (${LEVELS.map(key => `${key}=${vulnerabilities[key]}`).join(", ")})`);
  }
  return Object.freeze({ total: 0 });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
const NESTED_NPM_MODE_KEYS = new Set([
  "npm_config_global_style", "npm_config_install_strategy",
  "npm_config_strict_peer_deps", "npm_config_legacy_peer_deps", "npm_config_force",
  "npm_config_shrinkwrap", "npm_config_package_lock", "npm_config_package_lock_only",
  "npm_config_parseable", "npm_config_json", "npm_config_if_present", "npm_config_dry_run",
  "npm_config_global", "npm_config_prefix", "npm_config_workspace", "npm_config_workspaces",
  "npm_config_ignore_scripts", "npm_config_omit", "npm_config_include", "npm_config_production",
  "npm_config_save", "npm_config_save_dev", "npm_config_save_optional", "npm_config_save_peer",
]);

export function nestedNpmEnvironment(environment = process.env, options = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("nested npm environment must be an environment record");
  }
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (NESTED_NPM_MODE_KEYS.has(key.toLowerCase())) delete result[key];
  }
  if (options.bin !== undefined) {
    if (typeof options.bin !== "string" || !isAbsolute(options.bin) || options.bin.includes(delimiter) || /[\0\r\n]/.test(options.bin)) {
      throw new TypeError("nested npm launcher directory must be an absolute PATH entry");
    }
    const pathKeys = Object.keys(result).filter(key => /^path$/i.test(key));
    const inherited = pathKeys.map(key => result[key]).filter(value => typeof value === "string" && value);
    for (const key of pathKeys) delete result[key];
    result.PATH = [options.bin, ...inherited].join(delimiter);
  }
  return result;
}
