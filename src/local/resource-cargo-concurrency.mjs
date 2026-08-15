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
  if (text === "default") return numericPlan(cores, maximum, preserve);
  if (!/^-?\d+$/.test(text)) return unboundedPlan(preserve);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed === 0) return unboundedPlan(preserve);
  const jobs = parsed < 0 ? cores + parsed : parsed;
  return numericPlan(jobs, maximum, preserve);
}
function numericPlan(jobs, maximum, preserve) {
  return Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= maximum
    ? { jobs, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function unboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
