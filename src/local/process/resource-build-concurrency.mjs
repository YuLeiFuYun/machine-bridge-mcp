import { availableParallelism } from "node:os";

export function cargoExplicitJobPlan(argv, environment = {}, maximum = 1024) {
  const declared = cargoDeclaredJobPlan(argv, maximum);
  if (declared) return declared;
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "CARGO_BUILD_JOBS")) return null;
  return cargoJobValuePlan(environment.CARGO_BUILD_JOBS, maximum, true);
}

function cargoDeclaredJobPlan(argv, maximum) {
  let plan = null;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const current = String(argv[index]);
    if (current === "--") break;
    if (["-j", "--jobs"].includes(current)) {
      plan = cargoJobValuePlan(argv[index + 1], maximum, false); index += 1; continue;
    }
    if (current.startsWith("--jobs=")) { plan = cargoJobValuePlan(current.slice("--jobs=".length), maximum, false); continue; }
    if (current.startsWith("-j") && current.length > 2) plan = cargoJobValuePlan(current.slice(2), maximum, false);
  }
  return plan;
}

function cargoJobValuePlan(value, maximum, preserve) {
  const text = String(value ?? "").trim();
  const cores = availableParallelism();
  if (text === "default") return cargoNumericPlan(cores, maximum, preserve);
  if (!/^-?\d+$/.test(text)) return cargoUnboundedPlan(preserve);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed === 0) return cargoUnboundedPlan(preserve);
  const jobs = parsed < 0 ? cores + parsed : parsed;
  return cargoNumericPlan(jobs, maximum, preserve);
}

function cargoNumericPlan(jobs, maximum, preserve) {
  return Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= maximum
    ? { jobs, elastic: false, unbounded: false, preserve } : cargoUnboundedPlan(preserve);
}

function cargoUnboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
const CMAKE_INT_MAX = 2_147_483_647;

export function cmakeBuildJobPlan(argv, environment = {}, maximum = 1024) {
  const buildIndex = (argv || []).findIndex((value, index) => index > 0 && String(value) === "--build");
  if (buildIndex < 0) return null;
  const args = argv.slice(buildIndex + 1);
  const separator = args.indexOf("--");
  const cmakeArgs = separator < 0 ? args : args.slice(0, separator);
  if (hasPreset(cmakeArgs) || (separator >= 0 && separator < args.length - 1)) return cmakeUnboundedPlan(true);
  return directPlan(cmakeArgs, maximum) || environmentPlan(environment, maximum);
}

function directPlan(args, maximum) {
  let plan = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    const flag = value.startsWith("--parallel") ? "--parallel" : value.startsWith("-j") ? "-j" : null;
    if (!flag) continue;
    if (value === flag) {
      const next = args[index + 1];
      if (next === undefined || cmakeIsFlag(next)) {
        plan = cmakeUnboundedPlan(false);
      } else {
        plan = cmakeNumericPlan(next, maximum, false);
        index += 1;
      }
    } else {
      let suffix = value.slice(flag.length);
      if (suffix.startsWith("=")) suffix = suffix.slice(1);
      plan = suffix ? cmakeNumericPlan(suffix, maximum, false) : cmakeInvalidPlan(false);
    }
    if (plan.invalid) return plan;
  }
  return plan;
}

function environmentPlan(environment, maximum) {
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "CMAKE_BUILD_PARALLEL_LEVEL")) return null;
  const value = String(environment.CMAKE_BUILD_PARALLEL_LEVEL ?? "");
  return value === "" ? cmakeUnboundedPlan(true) : cmakeNumericPlan(value, maximum, true);
}

function cmakeNumericPlan(value, maximum, preserve) {
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) return cmakeInvalidPlan(preserve);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CMAKE_INT_MAX) return cmakeInvalidPlan(preserve);
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : cmakeUnboundedPlan(preserve);
}

function cmakeIsFlag(value) {
  const text = String(value || "");
  return text.startsWith("-") && !/^-\d/.test(text);
}

function hasPreset(args) {
  return args.some((value) => String(value) === "--preset" || String(value).startsWith("--preset="));
}

function cmakeInvalidPlan(preserve) {
  return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true };
}

function cmakeUnboundedPlan(preserve) {
  return { jobs: null, elastic: false, unbounded: true, preserve };
}
export function makeCommandJobPlan(argv, maximum = 1024) {
  return makeTokensPlan((argv || []).slice(1).map(String), maximum, false).plan;
}

export function makeFlagsJobPlan(environment = {}, maximum = 1024) {
  let plan = null; let jobserver = false;
  for (const key of ["GNUMAKEFLAGS", "MAKEFLAGS"]) {
    if (!Object.prototype.hasOwnProperty.call(environment || {}, key)) continue;
    const tokens = words(environment[key]);
    if (tokens[0] && !tokens[0].startsWith("-") && !tokens[0].includes("=")) tokens[0] = `-${tokens[0]}`;
    const parsed = makeTokensPlan(tokens, maximum, true);
    if (parsed.plan) plan = parsed.plan;
    jobserver ||= parsed.jobserver;
  }
  return plan || (jobserver ? makeUnboundedPlan(true) : null);
}

function makeTokensPlan(tokens, maximum, preserve) {
  let plan = null; let jobserver = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (["-j", "--jobs"].includes(current)) {
      const next = tokens[index + 1];
      if (/^\d+$/.test(next || "")) { plan = makeNumericPlan(next, maximum, preserve); index += 1; }
      else plan = makeUnboundedPlan(preserve);
    } else if (current.startsWith("--jobs=")) plan = makeNumericPlan(current.slice("--jobs=".length), maximum, preserve);
    else if (/^-[A-Za-z]*j/.test(current)) plan = compactPlan(current, maximum, preserve);
    if (current.startsWith("--jobserver-auth=") || current.startsWith("--jobserver-fds=")) jobserver = true;
  }
  return { plan, jobserver };
}

function compactPlan(value, maximum, preserve) {
  const suffix = /^-[A-Za-z]*j(.*)$/.exec(value)?.[1] ?? "";
  return suffix ? makeNumericPlan(suffix, maximum, preserve) : makeUnboundedPlan(preserve);
}

function makeNumericPlan(value, maximum, preserve) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? { jobs: parsed, elastic: false, unbounded: false, preserve } : makeUnboundedPlan(preserve);
}

function makeUnboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }

function words(value) { return String(value || "").trim().split(/\s+/).filter(Boolean); }
const NINJA_INT_MAX = 2_147_483_647;

export function ninjaCommandJobPlan(argv, maximum = 1024) {
  let plan = null;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || ""); if (value === "--" || value === "-t" || value.startsWith("-t")) break;
    if (value === "-j") { plan = ninjaNumericPlan(argv[index + 1], maximum); index += 1; }
    else if (value.startsWith("-j") && value.length > 2) plan = ninjaNumericPlan(value.slice(2), maximum);
    else if (value === "--jobs" || value.startsWith("--jobs=")) return ninjaCmdInvalidPlan();
    if (plan?.invalid) return plan;
  }
  return plan;
}

function ninjaNumericPlan(value, maximum) {
  const text = String(value ?? ""); if (!/^\d+$/.test(text)) return ninjaCmdInvalidPlan();
  const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed === 0 || parsed >= NINJA_INT_MAX || parsed > maximum) return ninjaCmdUnboundedPlan();
  return { jobs: parsed, elastic: false, unbounded: false, preserve: false };
}

function ninjaCmdInvalidPlan() { return { jobs: null, elastic: false, unbounded: false, preserve: false, invalid: true }; }

function ninjaCmdUnboundedPlan() { return { jobs: null, elastic: false, unbounded: true, preserve: false }; }
export function ninjaJobserverPlan(argv, environment = {}, _maximum = 1024, platform = process.platform) {
  if ((argv || []).slice(1).some((value) => String(value) === "-n")) return null;
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "MAKEFLAGS")) return null;
  const flags = String(environment.MAKEFLAGS || "");
  return validNinjaJobserver(flags, platform) ? cooperativePlan() : null;
}

function validNinjaJobserver(flags, platform) {
  const args = String(flags).trim().split(/\s+/).filter(Boolean);
  if (args[0] && !args[0].startsWith("-") && args[0].includes("n")) return false;
  let mode = null; let resource = "";
  for (const arg of args) {
    if (arg.startsWith("--jobserver-auth=")) [mode, resource] = authMode(arg.slice("--jobserver-auth=".length));
    else if (arg.startsWith("--jobserver-fds=")) {
      const pair = descriptorPair(arg.slice("--jobserver-fds=".length)); if (pair === null) return false;
      mode = pair ? "pipe" : "none"; resource = "";
    }
  }
  return platform === "win32" ? mode === "semaphore" && resource.length > 0 : mode === "fifo" && resource.length > 0;
}

function authMode(value) {
  const pair = descriptorPair(value); if (pair !== null) return [pair ? "pipe" : "none", ""];
  return value.startsWith("fifo:") ? ["fifo", value.slice(5)] : ["semaphore", value];
}

function descriptorPair(value) {
  const match = /^(-?\d+),(-?\d+)/.exec(value); return match ? Number(match[1]) >= 0 && Number(match[2]) >= 0 : null;
}

function cooperativePlan() { return { jobs: null, elastic: false, unbounded: true, preserve: true }; }
const SWIFT_UINT32_MAX = 4_294_967_295;

export function swiftJobPlan(argv, maximum = 1024) {
  let plan = null;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || ""); if (value === "--") break;
    let current = null;
    if (["-j", "--jobs"].includes(value)) {
      if (index + 1 >= argv.length) return swiftInvalidPlan();
      current = swiftNumericPlan(argv[index + 1], maximum); index += 1;
    } else if (value.startsWith("--jobs=")) {
      const attached = value.slice("--jobs=".length); if (!attached && index + 1 >= argv.length) return swiftInvalidPlan(); current = swiftNumericPlan(attached || argv[++index], maximum);
    } else if (value.startsWith("-j=")) {
      const attached = value.slice("-j=".length); if (!attached) return swiftInvalidPlan(); current = swiftNumericPlan(attached, maximum);
    } else if (value.startsWith("-j") && value !== "-j") return swiftInvalidPlan();
    if (current?.invalid) return current;
    if (current) plan = current;
  }
  return plan;
}

function swiftNumericPlan(value, maximum) {
  const text = String(value ?? "");
  if (!/^\+?\d+$/.test(text)) return swiftInvalidPlan();
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > SWIFT_UINT32_MAX) return swiftInvalidPlan();
  if (parsed === 0) return swiftUnboundedPlan();
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false } : swiftUnboundedPlan();
}

function swiftInvalidPlan() { return { jobs: null, elastic: false, unbounded: false, invalid: true }; }

function swiftUnboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
export function xcodeBuildJobPlan(argv, maximum = 1024) {
  let plan = null; let seen = 0;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "-jobs") {
      seen += 1; if (seen > 1 || index + 1 >= argv.length) return xcodeInvalidPlan();
      plan = xcodeJobValuePlan(argv[index + 1], maximum); index += 1;
    } else if (value.startsWith("-jobs=")) {
      return xcodeUnboundedPlan();
    } else if (value.startsWith("-jobs")) return xcodeUnboundedPlan();
  }
  return plan;
}

export function xcodeHasIndependentTestFanout(argv) {
  return (argv || []).slice(1).some((value) => ["test", "test-without-building"].includes(String(value)));
}

export function xcodeResourcePlan(base, argv, defaultJobs = 3, maximum = 1024) {
  if (base !== "xcodebuild") return { resourceClass: "unbounded", cpu: 6, compilerJobs: null, elastic: false, unbounded: true };
  const build = xcodeBuildJobPlan(argv, maximum); if (build?.invalid) return build;
  const plan = build || { jobs: defaultJobs, elastic: true, unbounded: false }; const unbounded = plan.unbounded || xcodeHasIndependentTestFanout(argv);
  return { resourceClass: unbounded ? "unbounded" : "mixed", cpu: unbounded ? 6 : plan.jobs, compilerJobs: plan.unbounded ? null : plan.jobs, elastic: !unbounded && plan.elastic, unbounded };
}

function xcodeJobValuePlan(value, maximum) {
  const text = String(value ?? "");
  if (/^\+?\d+$/.test(text)) {
    const parsed = Number(text); if (!Number.isSafeInteger(parsed)) return xcodeUnboundedPlan();
    if (parsed < 1) return xcodeInvalidPlan();
    return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false } : xcodeUnboundedPlan();
  }
  if (/^-\d+$/.test(text)) return xcodeInvalidPlan();
  return xcodeUnboundedPlan();
}

function xcodeInvalidPlan() { return { jobs: null, elastic: false, unbounded: false, invalid: true }; }

function xcodeUnboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
