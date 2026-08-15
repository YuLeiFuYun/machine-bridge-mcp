const SWIFT_UINT32_MAX = 4_294_967_295;

export function swiftJobPlan(argv, maximum = 1024) {
  let plan = null;
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || ""); if (value === "--") break;
    let current = null;
    if (["-j", "--jobs"].includes(value)) {
      if (index + 1 >= argv.length) return invalidPlan();
      current = numericPlan(argv[index + 1], maximum); index += 1;
    } else if (value.startsWith("--jobs=")) {
      const attached = value.slice("--jobs=".length); if (!attached && index + 1 >= argv.length) return invalidPlan(); current = numericPlan(attached || argv[++index], maximum);
    } else if (value.startsWith("-j=")) {
      const attached = value.slice("-j=".length); if (!attached) return invalidPlan(); current = numericPlan(attached, maximum);
    } else if (value.startsWith("-j") && value !== "-j") return invalidPlan();
    if (current?.invalid) return current;
    if (current) plan = current;
  }
  return plan;
}

function numericPlan(value, maximum) {
  const text = String(value ?? "");
  if (!/^\+?\d+$/.test(text)) return invalidPlan();
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > SWIFT_UINT32_MAX) return invalidPlan();
  if (parsed === 0) return unboundedPlan();
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false } : unboundedPlan();
}
function invalidPlan() { return { jobs: null, elastic: false, unbounded: false, invalid: true }; }
function unboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
