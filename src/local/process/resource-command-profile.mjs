import { availableParallelism, homedir } from "node:os";
import { cargoExplicitJobPlan, cmakeBuildJobPlan, makeCommandJobPlan, makeFlagsJobPlan, ninjaCommandJobPlan, ninjaJobserverPlan, swiftJobPlan, xcodeResourcePlan } from "./resource-build-concurrency.mjs";
import { goJobPlan, gradleJobPlan, mavenJobPlan, pytestWorkerPlan } from "./resource-lang-concurrency.mjs";
import { basename, isAbsolute, resolve, dirname, join } from "node:path";
import { markElasticCompilerJobs, markPreservedCompilerJobs, preservesCompilerJobs } from "./resource-leases.mjs";
import { xcodeIsLightCommand, xcodeNonBuildResourcePlan } from "./resource-xcode.mjs";
import { isTrustedLightInvocation } from "./resource-light-command.mjs";
import { releaseControlCommandIsLight } from "./resource-metrics.mjs";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createExclusiveFileSync } from "../core/exclusive-file.mjs";
import { ensureOwnerOnlyDirectorySync, ownerOnlyFile } from "../core/secure-file.mjs";

export const DEFAULT_COMPILER_JOBS = 3;

export function cargoJobPlan(argv, environment = {}) { return cargoExplicitJobPlan(argv, environment) || { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false }; }

export function genericBuildJobPlan(base, argv, _text, options = {}) {
  if (!["make", "ninja", "cmake", "gradle", "gradlew", "mvn", "mvnw", "go"].includes(base)) return null;
  const fallback = { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false };
  if (base === "make") return makeCommandJobPlan(argv) || makeFlagsJobPlan(options.environment) || fallback;
  if (base === "go") return goJobPlan(argv, options.environment) || { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false };
  if (base === "cmake") return cmakeBuildJobPlan(argv, options.environment) || { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false };
  if (base === "ninja") return ninjaCommandJobPlan(argv) || ninjaJobserverPlan(argv, options.environment) || { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false };
  if (["gradle", "gradlew"].includes(base)) return gradleJobPlan(argv, options.environment) || fallback;
  return mavenJobPlan(argv, options.environment) || fallback;
}

export function verificationFanoutPlan(environment = {}) {
  const value = environment?.MBM_CHECK_CONCURRENCY;
  if (hasConfiguredValue(value)) {
    const configured = configuredJobs(value, 16);
    return configured === null ? unboundedPlan() : { jobs: configured, elastic: false, unbounded: false };
  }
  return { jobs: Math.max(1, Math.min(4, availableParallelism())), elastic: true, unbounded: false };
}

function configuredJobs(value, maximum) {
  if (!hasConfiguredValue(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function hasConfiguredValue(value) { return value !== undefined && value !== null && value !== ""; }

function unboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
const HEAVY_SCRIPT_MARKER = /(?:^|[._-])(?:check|checks|build|test|tests|testing|verify|verification|gate|release|archive|fuzz|coverage|benchmark|bench|smoke)(?:$|[._-])/i;

const HEAVY_PACKAGE_SEGMENT = /(?:^|[:._-])(?:check|build|test|tests|verify|gate|release|archive|fuzz|coverage|benchmark|bench|smoke)(?:$|[:._-])/i;

const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|js|mjs|cjs|py|rb|pl)$/i;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

export function heavyScriptName(value) {
  const raw = String(value || "");
  const name = basename(raw).toLowerCase();
  const scriptLike = raw.includes("/") || raw.includes("\\") || SCRIPT_EXTENSION.test(name);
  return scriptLike && HEAVY_SCRIPT_MARKER.test(name);
}

export function directInterpreterHeavyScript(base, args = []) {
  const node = base === "node" || base === "node.exe";
  const python = /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(base);
  if (!node && !python) return false;
  const values = args.map(String);
  if (python && values.some((value) => ["-c", "-m"].includes(value))) return false;
  if (node && values.some((value) => ["-e", "--eval", "-p", "--print"].includes(value))) return false;
  const operand = values.find((value) => !value.startsWith("-")) || "";
  return Boolean(operand && heavyScriptName(operand));
}

export function verificationPlanCommand(base, args = []) {
  const values = args.map(String);
  if ((base === "node" || base === "node.exe") && basename(values.find((value) => !value.startsWith("-")) || "").toLowerCase() === "run-checks.mjs") return true;
  if (!PACKAGE_MANAGERS.has(base)) return false;
  const first = String(values[0] || "").toLowerCase();
  const script = ["run", "run-script"].includes(first) ? String(values[1] || "").toLowerCase() : first;
  return ["check", "check:fast", "check:full", "check:platform"].includes(script);
}

export function packageManagerTokensHeavy(tokens = []) {
  const head = String(tokens[0] || "").toLowerCase();
  if (!PACKAGE_MANAGERS.has(head)) return false;
  const args = tokens.slice(1).map((value) => String(value));
  const first = String(args[0] || "").toLowerCase();
  if (["install", "ci", "build", "test"].includes(first)) return true;
  if (["run", "run-script"].includes(first)) return heavyPackageScriptName(args[1]);
  return ["pnpm", "yarn", "bun"].includes(head) && heavyPackageScriptName(first);
}

export function heavyPackageScriptName(value) {
  return HEAVY_PACKAGE_SEGMENT.test(String(value || "").toLowerCase());
}
export function shellPayload(base, args) {
  if (!["zsh", "bash", "sh", "powershell.exe", "pwsh", "cmd.exe"].includes(base)) return "";
  const index = args.findIndex((entry) => ["-c", "-command", "/c"].includes(entry.toLowerCase()));
  return index >= 0 ? String(args[index + 1] || "") : args.join(" ");
}

export function shellSegments(text) {
  return String(text || "").split(/&&|\|\||[;|()\n]/).map((value) => value.trim()).filter(Boolean);
}

export function commandTokens(segment) {
  const tokens = String(segment).trim().split(/\s+/).filter(Boolean); let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || ["env", "command", "exec", "time"].includes(token)) { index += 1; continue; }
    if (token === "nice") { index += 1; if (tokens[index] === "-n") index += 2; else if (/^-?\d+$/.test(tokens[index] || "")) index += 1; continue; }
    break;
  }
  return tokens.slice(index).map((value, tokenIndex) => tokenIndex ? value : basename(value).toLowerCase());
}

export function shellCommandHeads(text) {
  return shellSegments(text).map((segment) => commandTokens(segment)[0]).filter(Boolean);
}

export function commandHeadIs(text, base, command) {
  return base === command || shellCommandHeads(text).includes(command);
}

export function commandHeadIn(text, base, commands) {
  return commands.includes(base) || shellCommandHeads(text).some((value) => commands.includes(value));
}

export function pythonModuleHeadIs(text, base, module) {
  if (/^python(?:3(?:\.\d+)?)?$/.test(base)) return String(text).includes(`-m ${module}`);
  return shellSegments(text).some((segment) => pythonModuleTokens(commandTokens(segment), module));
}

export function pythonModuleTokens(tokens, module) {
  return /^python(?:3(?:\.\d+)?)?$/.test(tokens[0] || "") && tokens[1] === "-m" && tokens[2] === module;
}

export function heavyShellScript(args, text) {
  const commandString = args.some((value) => String(value).toLowerCase() === "-c");
  const direct = commandString ? null : args.find((value) => !String(value).startsWith("-"));
  if (direct && heavyScriptName(direct)) return true;
  return shellSegments(text).some((segment) => {
    const tokens = commandTokens(segment);
    if (!tokens.length) return false;
    if (heavyScriptName(tokens[0])) return true;
    if (!["sh", "bash", "zsh"].includes(tokens[0])) return false;
    const script = tokens.slice(1).find((token) => !String(token).startsWith("-"));
    return Boolean(script && heavyScriptName(script));
  });
}
const GIB = 1024 ** 3;

export function resourceCommandProfile(command, args = [], options = {}) {
  const rawCommand = String(command || "");
  const argv = [rawCommand, ...args.map(String)];
  const base = basename(argv[0]).toLowerCase();
  const shellText = shellPayload(base, argv.slice(1));
  const shellTokens = shellText ? shellSegments(shellText).map(commandTokens) : [];
  const text = shellText || argv.join(" ");
  const priority = normalizePriority(options.priority);

  if (isTrustedDiskReclaimExecutable(rawCommand)) return profile("disk-reclaim", "io", 0.25, 0.75, 256, 0, priority);
  if (isTrustedLightInvocation(rawCommand, argv.slice(1), options.environment)) return lightProfile(priority);
  if (isLightMetadataInvocation(base, argv.slice(1))
      || (shellTokens.length > 0 && shellTokens.every((tokens) => isLightMetadataInvocation(basename(String(tokens[0] || "")).toLowerCase(), tokens.slice(1))))) {
    return lightProfile(priority);
  }
  if (base === "xcodebuild" && xcodeIsLightCommand(argv.slice(1))) return lightProfile(priority);
  if (base === "xcodebuild") { const plan = xcodeNonBuildResourcePlan(argv.slice(1));
    if (plan) return profile(plan.family, plan.resourceClass, plan.cpu, plan.io, plan.memoryMb, plan.diskBytes, priority, { unbounded: plan.unbounded, serializeProject: plan.serializeProject }); }
  const buildProfile = compilerBuildProfile(base, argv, text, shellTokens, priority, options.environment);
  if (buildProfile) return buildProfile;
  return remainingCommandProfile(base, argv, text, shellTokens, priority, options.environment, options.releaseControlWorkspace === true);
}

function remainingCommandProfile(base, argv, text, shellTokens, priority, environment, releaseControlWorkspace) {
  if (releaseControlWorkspace && releaseControlCommandIsLight(base, argv.slice(1))) return profile("release-control", "light", 0, 0, 0, 0, priority);
  if (/^pytest(?:-\d+(?:\.\d+)*)?$/.test(base) || commandHeadIs(text, base, "pytest") || pythonModuleHeadIs(text, base, "pytest")) {
    const plan = pytestWorkerPlan(argv, text);
    return profile("pytest", plan.unbounded ? "unbounded" : "cpu", plan.unbounded ? 6 : plan.jobs, 0.12,
      plan.unbounded ? 3072 : Math.max(768, plan.jobs * 768), 1 * GIB, priority, { unbounded: plan.unbounded });
  }
  if (verificationPlanCommand(base, argv.slice(1))
      || shellTokens.some((tokens) => verificationPlanCommand(tokens[0] || "", tokens.slice(1)))) {
    const plan = verificationFanoutPlan(environment);
    return profile("verification-plan", plan.unbounded ? "unbounded" : "mixed", plan.unbounded ? 6 : plan.jobs, 0.6,
      plan.unbounded ? 4096 : Math.max(2048, plan.jobs * 1024), 3 * GIB, priority, {
        compilerJobs: plan.jobs, elasticCompilerJobs: plan.elastic, elasticMemoryFloorMb: 2048,
        unbounded: plan.unbounded, serializeProject: true,
      });
  }
  if (directInterpreterHeavyScript(base, argv.slice(1))
      || shellTokens.some((tokens) => directInterpreterHeavyScript(tokens[0] || "", tokens.slice(1)))) {
    return profile("script-heavy", "mixed", 2.5, 0.5, 2048, 3 * GIB, priority, { serializeProject: true });
  }
  if (commandHeadIn(text, base, ["rustc", "swiftc", "swift-frontend", "clang++", "clang", "gcc", "g++"])) {
    return profile("compiler", "cpu", 1, 0.2, 1536, 1 * GIB, priority);
  }
  const packageScriptHeavy = packageManagerTokensHeavy([base, ...argv.slice(1)])
    || shellTokens.some((tokens) => packageManagerTokensHeavy(tokens));
  if (packageScriptHeavy) {
    return profile("js-build", "mixed", 2, 0.5, 2048, 3 * GIB, priority, { serializeProject: true });
  }
  if (commandHeadIs(text, base, "git") && /(?:^|\s)(?:add|checkout|clone|gc|repack|reset)(?:\s|$)/i.test(text)) {
    return profile("git-write", "io", 1, 0.8, 768, 3 * GIB, priority, { serializeProject: true });
  }
  if (commandHeadIn(text, base, ["rsync", "ditto", "tar", "zip", "unzip"])) {
    return profile("bulk-io", "io", 1, 0.9, 768, 6 * GIB, priority);
  }
  if (["sh", "bash", "zsh"].includes(base) && heavyShellScript(argv.slice(1), text)) {
    return profile("script-heavy", "mixed", 2.5, 0.5, 2048, 3 * GIB, priority, { serializeProject: true });
  }
  return profile("generic-process", "adaptive", 0.5, 0.1, 512, 0, priority);
}

export function resourceCommandEffectiveCwd(command, args, cwd, request = null) {
  const baseCwd = resolve(cwd || process.cwd());
  const base = basename(String(command || "")).toLowerCase();
  const payload = shellPayload(base, args.map(String));
  if (!payload || !request?.family) return baseCwd;
  const expected = familyCommands(request.family);
  let current = baseCwd;
  let cwdCertain = true;
  let resolvedCd = false;
  for (const segment of shellSegments(payload)) {
    const tokens = commandTokens(segment);
    if (!tokens.length) continue;
    if (tokens[0] === "cd") {
      const raw = String(tokens[1] || "");
      const canReanchor = isAbsolute(raw) || raw === "~" || raw.startsWith("~/");
      const next = cwdCertain || canReanchor ? simpleCdPath(raw, current) : null;
      if (next) { current = next; cwdCertain = true; resolvedCd = true; }
      else cwdCertain = false;
      continue;
    }
    if (expected.includes(tokens[0]) || request.family === "pytest" && pythonModuleTokens(tokens, "pytest")) {
      return cwdCertain ? current : baseCwd;
    }
  }
  return request.serialize_project === true && resolvedCd && cwdCertain ? current : baseCwd;
}

export function applyResourceProfileEnv(environment, request) {
  const env = { ...environment };
  if (request?.family === "cargo" && request.compiler_jobs && !env.CARGO_BUILD_JOBS) {
    env.CARGO_BUILD_JOBS = String(request.compiler_jobs);
  }
  if (request?.family === "verification-plan" && request.compiler_jobs && !env.MBM_CHECK_CONCURRENCY) {
    env.MBM_CHECK_CONCURRENCY = String(request.compiler_jobs);
  }
  return env;
}

function profile(family, resourceClass, cpu, io, memoryMb, diskBytes, priority, extra = {}) {
  return markPreservedCompilerJobs(markElasticCompilerJobs({
    family,
    resource_class: resourceClass,
    priority,
    cpu: Math.max(0, Number(cpu) || 0),
    io: Math.max(0, Number(io) || 0),
    memory_mb: Math.max(0, Number(memoryMb) || 0),
    disk_reserve_bytes: Math.max(0, Number(diskBytes) || 0),
    heavy: resourceClass !== "light",
    compiler_jobs: extra.compilerJobs ?? null,
    unbounded: extra.unbounded === true,
    serialize_project: extra.serializeProject === true,
  }, extra.elasticCompilerJobs === true, extra.elasticMemoryFloorMb), extra.preserveCompilerJobs === true);
}

function compilerBuildProfile(base, argv, text, shellTokens, priority, environment) {
  if (commandHeadIs(text, base, "cargo")) {
    const plan = cargoJobPlan(argv, environment);
    return profile("cargo", plan.unbounded ? "unbounded" : "mixed", plan.unbounded ? 6 : plan.jobs, 0.55, 3072, 4 * GIB, priority, {
      compilerJobs: plan.jobs, elasticCompilerJobs: plan.elastic, preserveCompilerJobs: plan.preserve === true,
      unbounded: plan.unbounded, serializeProject: true,
    });
  }
  if (commandHeadIs(text, base, "swift") && /(?:^|\s)(?:build|test|package)(?:\s|$)/i.test(text)) { const direct = base === "swift";
    const shellSwift = !direct && shellTokens.length === 1 && basename(String(shellTokens[0]?.[0] || "")).toLowerCase() === "swift" ? shellTokens[0] : null;
    const explicit = swiftJobPlan(direct ? argv : shellSwift); if (direct && explicit?.invalid) return profile("build-validation", "light", 0, 0, 0, 0, priority);
    const plan = explicit || (direct ? { jobs: DEFAULT_COMPILER_JOBS, elastic: true, unbounded: false } : { jobs: null, elastic: false, unbounded: true }); const controllable = !plan.invalid && !plan.unbounded;
    return profile("swift", controllable ? "mixed" : "unbounded", controllable ? plan.jobs : 6, 0.55, 3072, 4 * GIB, priority, { compilerJobs: controllable ? plan.jobs : null, elasticCompilerJobs: direct && plan.elastic, unbounded: !controllable, serializeProject: true });
  }
  if (commandHeadIs(text, base, "xcodebuild")) {
    const plan = xcodeResourcePlan(base, argv, DEFAULT_COMPILER_JOBS); if (plan?.invalid) return profile("build-validation", "light", 0, 0, 0, 0, priority);
    return profile("xcodebuild", plan.resourceClass, plan.cpu, 0.75, 4096, 8 * GIB, priority, { compilerJobs: plan.compilerJobs, elasticCompilerJobs: plan.elastic, unbounded: plan.unbounded, serializeProject: true });
  }
  const generic = commandHeadIn(text, base, ["make", "ninja", "gradle", "gradlew"])
    || commandHeadIs(text, base, "cmake") && /(?:^|\s)--build(?:\s|$)/.test(text)
    || commandHeadIn(text, base, ["mvn", "mvnw"]) && /(?:^|\s)(?:test|package|install)(?:\s|$)/.test(text)
    || commandHeadIs(text, base, "go") && /(?:^|\s)(?:test|build)(?:\s|$)/.test(text);
  if (!generic) return null;
  const plan = genericBuildJobPlan(base, argv, text, { environment });
  if (plan?.invalid) return profile("build-validation", "light", 0, 0, 0, 0, priority);
  const controllable = Boolean(plan && !plan.unbounded);
  return profile("generic-build", controllable ? "mixed" : "unbounded", controllable ? plan.jobs : 6, 0.65, 3072, 5 * GIB, priority, {
    compilerJobs: controllable ? plan.jobs : null, elasticCompilerJobs: controllable && plan.elastic,
    preserveCompilerJobs: plan?.preserve === true, unbounded: !controllable, serializeProject: true,
  });
}

function lightProfile(priority) { return profile("light", "light", 0, 0, 0, 0, priority); }

const METADATA_BUILD_TOOLS = new Set([
  "cargo", "rustc", "swift", "xcodebuild", "make", "ninja", "cmake", "gradle", "gradlew", "mvn", "mvnw", "go",
]);

function isLightMetadataInvocation(base, args = []) {
  const values = (args || []).map(String);
  const stopAt = values.indexOf("--");
  const headArgs = stopAt < 0 ? values : values.slice(0, stopAt);
  if (METADATA_BUILD_TOOLS.has(base) && headArgs.some((value) => ["--version", "-V", "--help", "-h"].includes(value))) return true;
  if (base === "cargo") {
    const subcommand = headArgs.find((value) => value && !value.startsWith("-"));
    if (subcommand === "metadata") return true;
  }
  if (base === "ninja" && headArgs.some((value) => value === "-t" || /^-t./.test(value))) return true;
  return false;
}

function normalizePriority(value) { return ["interactive", "ordinary", "background"].includes(value) ? value : "ordinary"; }

function isTrustedDiskReclaimExecutable(command) {
  return ["/bin/rm", "/usr/bin/rm", "/bin/rmdir", "/usr/bin/rmdir", "/usr/bin/unlink"].includes(command);
}

function familyCommands(family) {
  if (family === "verification-plan") return ["npm", "pnpm", "yarn", "bun", "node"];
  if (family === "js-build") return ["npm", "pnpm", "yarn", "bun"];
  if (family === "generic-build") return ["make", "ninja", "cmake", "gradle", "gradlew", "mvn", "mvnw", "go"];
  if (family === "bulk-io") return ["rsync", "ditto", "tar", "zip", "unzip"];
  if (family === "compiler") return ["rustc", "swiftc", "swift-frontend", "clang++", "clang", "gcc", "g++"];
  return [family];
}

function simpleCdPath(value, cwd) {
  const raw = String(value || "");
  if (!raw || raw === "-" || /[$`'"*?{}[\]]/.test(raw)) return null;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}
export function resourceRequestForProject(request, cwd) {
  const result = { ...request };
  if (result.serialize_project !== true) return result;
  const project = normalizeResourceProjectIdentity(canonicalResourceProjectPath(cwd));
  return { ...result, contention_key: resourceProjectContentionKey(result.family, project) };
}

export function resourceProjectContentionKey(family, projectIdentity) {
  const material = `agent-resource-contention-v1\0${family || "unknown"}\0${String(projectIdentity || "")}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function resourceProjectIdentityHash(projectIdentity) {
  return createHash("sha256").update(String(projectIdentity || "")).digest("hex").slice(0, 24);
}

export function resourceProjectHash(cwd) {
  const identity = normalizeResourceProjectIdentity(canonicalResourceProjectPath(cwd));
  return resourceProjectIdentityHash(identity);
}

export function canonicalResourceProjectPath(cwd) {
  const target = resolve(cwd || process.cwd());
  const missing = [];
  let current = target;
  while (true) {
    try {
      const canonical = realpathSync.native ? realpathSync.native(current) : realpathSync(current);
      return missing.reduceRight((value, name) => resolve(value, name), canonical);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function normalizeResourceProjectIdentity(value, platform = process.platform) {
  let text = String(value || "");
  if (platform !== "win32") return text;
  text = text.replaceAll("/", "\\");
  const folded = text.toLowerCase();
  const extendedUnc = "\\\\?\\unc\\";
  const extended = "\\\\?\\";
  if (folded.startsWith(extendedUnc)) text = `\\\\${text.slice(extendedUnc.length)}`;
  else if (folded.startsWith(extended)) text = text.slice(extended.length);
  return text.toLowerCase();
}
export function defaultAgentBuildRoot(env = process.env) {
  if (env.AGENT_BUILD_ROOT) return resolve(String(env.AGENT_BUILD_ROOT));
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "AgentBuilds.noindex");
  if (process.platform === "win32") return resolve(env.LOCALAPPDATA || env.APPDATA || homedir(), "AgentBuilds");
  return join(env.XDG_CACHE_HOME ? resolve(String(env.XDG_CACHE_HOME)) : join(homedir(), ".cache"), "agent-builds");
}

export function prepareResourceBuildCommand(command, args, environment, request, cwd, options = {}) {
  const env = { ...environment };
  const argv = args.map(String);
  if (!request?.heavy) return { command, args: argv, environment: env };
  const base = basename(String(command || "")).toLowerCase();
  applyCompilerConcurrency(argv, base, request);
  if (!buildRootRelevant(request.family)) return { command, args: argv, environment: env };
  const root = ensureBuildRoot(options.root || defaultAgentBuildRoot(options.env));
  const project = projectBuildHash(cwd);
  env.AGENT_BUILD_ROOT ||= root;

  if (request.family === "cargo") {
    const target = ensureProjectBuildDir(root, "cargo", project);
    if (!env.CARGO_TARGET_DIR && !hasOption(argv, "--target-dir")) env.CARGO_TARGET_DIR = target;
  } else if (request.family === "swift" && base === "swift") {
    const scratch = ensureProjectBuildDir(root, "swift", project);
    if (!hasAnyOption(argv, ["--scratch-path", "--build-path"])) insertSwiftOption(argv, "--scratch-path", scratch);
    if (request.compiler_jobs && !hasAnyOption(argv, ["-j", "--jobs"])) insertSwiftOption(argv, "-j", String(request.compiler_jobs));
  } else if (request.family === "xcodebuild" && base === "xcodebuild") {
    const derived = ensureProjectBuildDir(root, "xcode", project);
    if (!hasOption(argv, "-derivedDataPath")) argv.unshift("-derivedDataPath", derived);
    if (request.compiler_jobs && !hasOption(argv, "-jobs")) argv.unshift("-jobs", String(request.compiler_jobs));
  }
  return { command, args: argv, environment: env };
}

export function projectBuildHash(cwd) {
  return resourceProjectHash(cwd || process.cwd());
}

function ensureBuildRoot(rootInput) {
  const root = resolve(rootInput);
  ensureOwnerOnlyDirectorySync(root);
  if (process.platform === "darwin") ensureNoIndexMarker(root);
  return root;
}

function ensureProjectBuildDir(root, family, project) {
  const dir = join(root, family, project);
  ensureOwnerOnlyDirectorySync(dir);
  return dir;
}

function ensureNoIndexMarker(root) {
  const marker = join(root, ".metadata_never_index");
  try { createExclusiveFileSync(marker, "", { mode: 0o600 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  ownerOnlyFile(marker);
}

function buildRootRelevant(family) { return ["cargo", "swift", "xcodebuild"].includes(String(family || "")); }

function hasOption(argv, option) { return argv.some((value) => value === option || value.startsWith(`${option}=`)); }

function hasAnyOption(argv, options) { return options.some((option) => hasOption(argv, option) || (option === "-j" && argv.some((value) => /^-j\d+$/.test(value)))); }

function insertSwiftOption(argv, flag, value) {
  const index = argv.length && ["build", "test", "package"].includes(argv[0]) ? 1 : 0;
  argv.splice(index, 0, flag, value);
}

function applyCompilerConcurrency(argv, base, request) {
  const jobs = request?.compiler_jobs;
  if (!jobs || request.family !== "generic-build" || preservesCompilerJobs(request)) return;
  if (base === "make" && !makeCommandJobPlan([base, ...argv])) argv.unshift("-j", String(jobs));
  else if (base === "ninja" && !hasAnyOption(argv, ["-j", "--jobs"])) argv.unshift("-j", String(jobs));
  else if (base === "cmake" && !hasCmakeParallelOption(argv)) insertBeforeSeparator(argv, "--parallel", String(jobs));
  else if (["gradle", "gradlew"].includes(base) && !hasOption(argv, "--max-workers")) argv.unshift("--max-workers", String(jobs));
  else if (["mvn", "mvnw"].includes(base) && !hasCompactOrLongOption(argv, "-T", "--threads")) argv.unshift("-T", String(jobs));
  else if (base === "go" && !hasGoParallelOption(argv) && ["build", "test"].includes(argv[0])) argv.splice(1, 0, "-p", String(jobs));
}

function hasCompactOrLongOption(argv, short, long) { return hasOption(argv, long) || argv.some((value) => value === short || value.startsWith(`${short}=`) || value.startsWith(short) && value.length > short.length); }

function hasCmakeParallelOption(argv) { const end = argv.indexOf("--"); return argv.slice(0, end < 0 ? argv.length : end).some((value) => value.startsWith("-j") || value.startsWith("--parallel")); }

function hasGoParallelOption(argv) { return argv.some((value) => ["-p", "--p"].includes(value) || /^--?p=/.test(value)); }

function insertBeforeSeparator(argv, flag, value) { const index = argv.indexOf("--"); argv.splice(index < 0 ? argv.length : index, 0, flag, value); }
