import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { cargoJobPlan, DEFAULT_COMPILER_JOBS, genericBuildJobPlan, verificationFanoutPlan } from "./resource-command-concurrency.mjs";
import { markElasticCompilerJobs, markPreservedCompilerJobs } from "./resource-elastic-request.mjs";
import { pytestWorkerPlan } from "./resource-pytest-concurrency.mjs";
import { swiftJobPlan } from "./resource-swift-concurrency.mjs";
import { xcodeResourcePlan } from "./resource-xcode-concurrency.mjs";
import { xcodeIsLightCommand } from "./resource-xcode-command.mjs";
import { xcodeNonBuildResourcePlan } from "./resource-xcode-non-build.mjs";
import { isTrustedLightExecutable } from "./resource-light-command.mjs";
import { releaseControlCommandIsLight } from "./resource-release-control-classification.mjs";
import { commandHeadIn, commandHeadIs, commandTokens, heavyShellScript, pythonModuleHeadIs, pythonModuleTokens, shellPayload, shellSegments } from "./resource-shell-analysis.mjs";
import { directInterpreterHeavyScript, packageManagerTokensHeavy, verificationPlanCommand } from "./resource-script-classification.mjs";
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
  if (isTrustedLightExecutable(rawCommand)) return lightProfile(priority);
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
