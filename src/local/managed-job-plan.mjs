import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readBoundedRegularFileWithInfoSync } from "./secure-file.mjs";
import { clampInteger } from "./numbers.mjs";

const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const RESOURCE_TOKEN = /\{\{resource:([a-z][a-z0-9._-]{0,63})\}\}/g;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_JOB_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCES = 64;
const MAX_TEMPORARY_FILE_BYTES = 512 * 1024;

export function validateResourceName(value) {
  const name = String(value || "").trim();
  if (!RESOURCE_NAME.test(name)) throw new Error("resource name must match [a-z][a-z0-9._-]{0,63}");
  return name;
}

export function inspectResourceFile(inputPath, { allowInsecurePermissions = false, includeHash = false } = {}) {
  const path = resolve(String(inputPath || ""));
  const canonical = realpathFile(path);
  const { buffer: content, info } = readBoundedRegularFileWithInfoSync(canonical, MAX_RESOURCE_BYTES);
  if (process.platform !== "win32" && !allowInsecurePermissions && (info.mode & 0o077) !== 0) {
    throw new Error("resource file is readable by group or others; restrict permissions or use --allow-insecure-permissions");
  }
  return {
    kind: "file",
    path: canonical,
    pathAliases: normalizeResourcePathAliases([path, canonical]),
    size: info.size,
    mode: process.platform === "win32" ? null : `0${(info.mode & 0o777).toString(8)}`,
    updatedAt: new Date().toISOString(),
    allowInsecurePermissions: allowInsecurePermissions === true,
    ...(includeHash ? { sha256: createHash("sha256").update(content).digest("hex") } : {}),
  };
}

export function publicResourceRegistry(resources = {}, { includePaths = false } = {}) {
  const normalized = normalizeResourceRegistry(resources);
  return Object.fromEntries(Object.entries(normalized).map(([name, value]) => [name, {
    kind: value.kind,
    size: value.size ?? null,
    mode: value.mode ?? null,
    updatedAt: value.updatedAt ?? null,
    allowInsecurePermissions: value.allowInsecurePermissions === true,
    paths_exposed: includePaths,
    ...(includePaths ? { path: value.path } : {}),
  }]));
}

export function validatePlan(args, context) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("job arguments must be an object");
  const allowed = new Set(["name", "steps", "finally_steps", "temporary_files"]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`job contains unknown field: ${key}`);
  const name = String(args.name || "managed job").trim().slice(0, 128) || "managed job";
  const steps = validateSteps(args.steps, "steps", context);
  const finallySteps = validateSteps(args.finally_steps || [], "finally_steps", context, true);
  const temporaryFiles = validateTemporaryFiles(args.temporary_files || []);
  if (!steps.length) throw new Error("steps must contain at least one step");
  return {
    version: 1,
    name,
    workspace: context.workspace,
    full_env: context.fullEnv,
    resources: referencedResources([...steps, ...finallySteps], context.resources),
    temporary_files: temporaryFiles,
    steps,
    finally_steps: finallySteps,
  };
}

function validateTemporaryFiles(value) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("temporary_files must contain 0-16 files");
  const seen = new Set();
  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`temporary_files[${index}] must be an object`);
    for (const key of Object.keys(item)) if (!["name", "content", "executable"].includes(key)) throw new Error(`temporary_files[${index}] contains unknown field: ${key}`);
    const name = validateResourceName(item.name);
    if (seen.has(name)) throw new Error(`duplicate temporary file name: ${name}`);
    seen.add(name);
    const content = boundedString(item.content, 256 * 1024, `temporary_files[${index}].content`);
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_TEMPORARY_FILE_BYTES) throw new Error(`temporary file contents exceed ${MAX_TEMPORARY_FILE_BYTES} bytes`);
    return { name, content, executable: item.executable === true };
  });
}

function validateSteps(value, label, context, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 16) {
    throw new Error(`${label} must contain ${allowEmpty ? "0-16" : "1-16"} steps`);
  }
  return value.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label}[${index}] must be an object`);
    const allowed = new Set(["name", "argv", "cwd", "env", "env_resources", "stdin", "stdin_resource", "timeout_seconds", "allow_failure", "capture_output"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`${label}[${index}] contains unknown field: ${key}`);
    if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 256) throw new Error(`${label}[${index}].argv must contain 1-256 strings`);
    const argv = input.argv.map((item) => boundedString(item, 16 * 1024, `${label}[${index}].argv`));
    if (Buffer.byteLength(JSON.stringify(argv)) > 64 * 1024) throw new Error(`${label}[${index}].argv exceeds 64 KiB`);
    const cwd = input.cwd === undefined ? context.workspace : resolveJobCwd(input.cwd, context.workspace, context.unrestrictedPaths);
    const env = validateEnv(input.env, `${label}[${index}].env`);
    const envResources = validateEnvResources(input.env_resources, `${label}[${index}].env_resources`);
    for (const key of Object.keys(envResources)) if (Object.prototype.hasOwnProperty.call(env, key)) throw new Error(`${label}[${index}] duplicates ${key} in env and env_resources`);
    const stdin = input.stdin === undefined ? null : boundedString(input.stdin, 256 * 1024, `${label}[${index}].stdin`);
    const stdinResource = input.stdin_resource === undefined ? null : validateResourceName(input.stdin_resource);
    if (stdin !== null && stdinResource !== null) throw new Error(`${label}[${index}] cannot combine stdin and stdin_resource`);
    return {
      name: String(input.name || basename(argv[0]) || `step ${index + 1}`).slice(0, 128),
      argv,
      cwd,
      env,
      env_resources: envResources,
      stdin,
      stdin_resource: stdinResource,
      timeout_seconds: clampInteger(input.timeout_seconds, 600, 1, 3600),
      allow_failure: input.allow_failure === true,
      capture_output: input.capture_output === "discard" ? "discard" : "redacted",
    };
  });
}

function validateEnv(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${label} has too many entries`);
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`${label} contains invalid variable name: ${key}`);
    out[key] = boundedString(raw, 16 * 1024, `${label}.${key}`);
  }
  return out;
}

function validateEnvResources(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error(`${label} has too many entries`);
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`${label} contains invalid variable name: ${key}`);
    out[key] = validateResourceName(raw);
  }
  return out;
}

function referencedResources(steps, registry) {
  const names = new Set();
  for (const step of steps) {
    if (step.stdin_resource) names.add(step.stdin_resource);
    for (const name of Object.values(step.env_resources || {})) names.add(name);
    for (const value of [...step.argv, ...Object.values(step.env)]) {
      for (const match of String(value).matchAll(RESOURCE_TOKEN)) names.add(match[1]);
    }
  }
  if (names.size > MAX_RESOURCES) throw new Error(`job references more than ${MAX_RESOURCES} local resources`);
  const out = Object.create(null);
  let totalBytes = 0;
  for (const name of names) {
    const resource = Object.hasOwn(registry, name) ? registry[name] : null;
    if (!resource) throw new Error(`unknown local resource: ${name}`);
    const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true, includeHash: true });
    totalBytes += inspected.size;
    if (totalBytes > MAX_JOB_RESOURCE_BYTES) throw new Error(`job resources exceed ${MAX_JOB_RESOURCE_BYTES} bytes`);
    out[name] = {
      ...inspected,
      pathAliases: normalizeResourcePathAliases([...(resource.pathAliases || []), ...(inspected.pathAliases || [])]),
      allowInsecurePermissions: resource.allowInsecurePermissions === true,
    };
  }
  return out;
}

export function normalizeResourceRegistry(resources) {
  const out = Object.create(null);
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return out;
  for (const [rawName, rawValue] of Object.entries(resources).slice(0, MAX_RESOURCES)) {
    const name = validateResourceName(rawName);
    if (!rawValue || rawValue.kind !== "file" || typeof rawValue.path !== "string") continue;
    out[name] = {
      kind: "file",
      path: resolve(rawValue.path),
      pathAliases: normalizeResourcePathAliases([rawValue.path, ...(Array.isArray(rawValue.pathAliases) ? rawValue.pathAliases : [])]),
      size: Number.isFinite(Number(rawValue.size)) ? Number(rawValue.size) : null,
      mode: rawValue.mode ?? null,
      updatedAt: rawValue.updatedAt ?? null,
      allowInsecurePermissions: rawValue.allowInsecurePermissions === true,
    };
  }
  return out;
}

function normalizeResourcePathAliases(values) {
  const aliases = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || value.includes("\0") || value.length > 4096) continue;
    const absolute = resolve(value);
    if (!aliases.includes(absolute)) aliases.push(absolute);
    if (aliases.length >= 8) break;
  }
  return aliases;
}

function resolveJobCwd(value, workspace, unrestrictedPaths) {
  const raw = boundedString(value, 4096, "cwd");
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
  const canonical = realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
  const info = statSync(canonical);
  if (!info.isDirectory()) throw new Error("managed job cwd is not a directory");
  if (!unrestrictedPaths) {
    const rel = relative(workspace, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("managed job cwd is outside the configured workspace");
  }
  return canonical;
}

function realpathFile(path) {
  const input = resolve(path);
  const linkInfo = lstatSync(input);
  if (!linkInfo.isFile() && !linkInfo.isSymbolicLink()) throw new Error("resource path is not a regular file");
  return realpathSync.native ? realpathSync.native(input) : realpathSync(input);
}

function boundedString(value, maxBytes, label) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} must be a string without NUL bytes`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}
