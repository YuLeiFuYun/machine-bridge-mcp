import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createExclusiveFileSync } from "./exclusive-file.mjs";
import { preservesCompilerJobs } from "./resource-elastic-request.mjs";
import { makeCommandJobPlan } from "./resource-make-concurrency.mjs";
import { ensureOwnerOnlyDirectorySync, ownerOnlyFile } from "./secure-file.mjs";
import { resourceProjectHash } from "./resource-project-key.mjs";

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
    if (!hasOption(argv, "--scratch-path")) insertSwiftOption(argv, "--scratch-path", scratch);
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
