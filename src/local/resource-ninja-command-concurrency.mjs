const NINJA_INT_MAX = 2_147_483_647;

export function ninjaCommandJobPlan(argv, maximum = 1024) {
  let plan = null;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || ""); if (value === "--" || value === "-t" || value.startsWith("-t")) break;
    if (value === "-j") { plan = ninjaNumericPlan(argv[index + 1], maximum); index += 1; }
    else if (value.startsWith("-j") && value.length > 2) plan = ninjaNumericPlan(value.slice(2), maximum);
    else if (value === "--jobs" || value.startsWith("--jobs=")) return invalidPlan();
    if (plan?.invalid) return plan;
  }
  return plan;
}
function ninjaNumericPlan(value, maximum) {
  const text = String(value ?? ""); if (!/^\d+$/.test(text)) return invalidPlan();
  const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed === 0 || parsed >= NINJA_INT_MAX || parsed > maximum) return unboundedPlan();
  return { jobs: parsed, elastic: false, unbounded: false, preserve: false };
}
function invalidPlan() { return { jobs: null, elastic: false, unbounded: false, preserve: false, invalid: true }; }
function unboundedPlan() { return { jobs: null, elastic: false, unbounded: true, preserve: false }; }
