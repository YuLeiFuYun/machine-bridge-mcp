export function xcodeBuildJobPlan(argv, maximum = 1024) {
  let plan = null; let seen = 0;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "-jobs") {
      seen += 1; if (seen > 1 || index + 1 >= argv.length) return invalidPlan();
      plan = xcodeJobValuePlan(argv[index + 1], maximum); index += 1;
    } else if (value.startsWith("-jobs=")) {
      return unboundedPlan();
    } else if (value.startsWith("-jobs")) return unboundedPlan();
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
    const parsed = Number(text); if (!Number.isSafeInteger(parsed)) return unboundedPlan();
    if (parsed < 1) return invalidPlan();
    return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false } : unboundedPlan();
  }
  if (/^-\d+$/.test(text)) return invalidPlan();
  return unboundedPlan();
}
function invalidPlan() { return { jobs: null, elastic: false, unbounded: false, invalid: true }; }
function unboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
