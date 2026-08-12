import { availableParallelism } from "node:os";
import { cargoExplicitJobPlan } from "./resource-cargo-concurrency.mjs";
import { cmakeBuildJobPlan } from "./resource-cmake-concurrency.mjs";
import { goJobPlan } from "./resource-go-concurrency.mjs";
import { gradleJobPlan } from "./resource-gradle-concurrency.mjs";
import { makeCommandJobPlan, makeFlagsJobPlan } from "./resource-make-concurrency.mjs";
import { mavenJobPlan } from "./resource-maven-concurrency.mjs";
import { ninjaCommandJobPlan } from "./resource-ninja-command-concurrency.mjs";
import { ninjaJobserverPlan } from "./resource-ninja-concurrency.mjs";
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
