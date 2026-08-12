const CMAKE_INT_MAX = 2_147_483_647;

export function cmakeBuildJobPlan(argv, environment = {}, maximum = 1024) {
  const buildIndex = (argv || []).findIndex((value, index) => index > 0 && String(value) === "--build");
  if (buildIndex < 0) return null;
  const args = argv.slice(buildIndex + 1); const separator = args.indexOf("--");
  const cmakeArgs = separator < 0 ? args : args.slice(0, separator);
  if (hasPreset(cmakeArgs) || separator >= 0 && separator < args.length - 1) return unboundedPlan(true);
  return directPlan(cmakeArgs, maximum) || environmentPlan(environment, maximum);
}

function directPlan(args, maximum) {
  let plan = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || ""); const flag = value.startsWith("--parallel") ? "--parallel" : value.startsWith("-j") ? "-j" : null;
    if (!flag) continue;
    if (value === flag) {
      const next = args[index + 1];
      if (next === undefined || cmakeIsFlag(next)) plan = unboundedPlan(false);
      else { plan = numericPlan(next, maximum, false); index += 1; }
    } else {
      let suffix = value.slice(flag.length); if (suffix.startsWith("=")) suffix = suffix.slice(1);
      plan = suffix ? numericPlan(suffix, maximum, false) : invalidPlan(false);
    }
    if (plan.invalid) return plan;
  }
  return plan;
}
function environmentPlan(environment, maximum) {
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "CMAKE_BUILD_PARALLEL_LEVEL")) return null;
  const value = String(environment.CMAKE_BUILD_PARALLEL_LEVEL ?? "");
  return value === "" ? unboundedPlan(true) : numericPlan(value, maximum, true);
}
function numericPlan(value, maximum, preserve) {
  const text = String(value); if (!/^\+?\d+$/.test(text)) return invalidPlan(preserve);
  const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CMAKE_INT_MAX) return invalidPlan(preserve);
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function cmakeIsFlag(value) { const text = String(value || ""); return text.startsWith("-") && !/^-\d/.test(text); }
function hasPreset(args) { return args.some((value) => String(value) === "--preset" || String(value).startsWith("--preset=")); }
function invalidPlan(preserve) { return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true }; }
function unboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
