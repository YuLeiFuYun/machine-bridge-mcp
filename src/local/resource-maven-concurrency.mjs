import { availableParallelism } from "node:os";

export function mavenJobPlan(argv, environment = {}, maximum = 1024) {
  const envArgs = Object.prototype.hasOwnProperty.call(environment || {}, "MAVEN_ARGS") ? words(environment.MAVEN_ARGS) : [];
  const envValue = mavenThreadValue(["mvn", ...envArgs]);
  if (envValue !== null) return mavenThreadPlan(envValue, maximum, true);
  const cliValue = mavenThreadValue(argv);
  return cliValue === null ? null : mavenThreadPlan(cliValue, maximum, false);
}

export function mavenCoreMultiplierPlan(argv, maximum = 1024) {
  const value = mavenThreadValue(argv);
  return value?.endsWith("C") ? multiplierPlan(value, maximum, false) : null;
}

function mavenThreadPlan(value, maximum, preserve) {
  if (value?.endsWith("C")) return multiplierPlan(value, maximum, preserve);
  const jobs = Number(value);
  return Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= maximum
    ? { jobs, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function multiplierPlan(value, maximum, preserve) {
  const multiplier = Number(String(value).slice(0, -1));
  if (!Number.isFinite(multiplier) || multiplier <= 0) return unboundedPlan(preserve);
  const jobs = Math.max(1, Math.trunc(multiplier * availableParallelism()));
  return jobs <= maximum ? { jobs, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function mavenThreadValue(argv) {
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || "");
    if (["-T", "--threads"].includes(value)) return String(argv[index + 1] || "").trim();
    if (value.startsWith("--threads=")) return value.slice("--threads=".length).trim();
    if (value.startsWith("-T") && value.length > 2) return value.slice(2).trim();
  }
  return null;
}
function unboundedPlan(preserve = false) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
function words(value) { return String(value || "").trim().split(/\s+/).filter(Boolean); }
