const WORKERS_PROPERTY = "org.gradle.workers.max";
const GRADLE_INT_MAX = 2_147_483_647;

export function gradleJobPlan(argv, environment = {}, maximum = 1024) {
  const property = gradlePropertyPlan(argv, environment, maximum); if (property?.invalid) return property;
  return gradleCliPlan(argv, maximum) || property;
}
function gradleCliPlan(argv, maximum) {
  const values = [];
  for (let index = 1; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || ""); if (value === "--") break;
    if (value === "--max-workers") { values.push(argv[index + 1]); index += 1; }
    else if (value.startsWith("--max-workers=")) values.push(value.slice("--max-workers=".length));
  }
  if (values.length > 1) return invalidPlan(false);
  return values.length ? numericPlan(values[0], maximum, false) : null;
}
function gradlePropertyPlan(argv, environment, maximum) {
  let property;
  for (const key of ["JAVA_OPTS", "GRADLE_OPTS"]) {
    if (!Object.prototype.hasOwnProperty.call(environment || {}, key)) continue;
    const tokens = splitJvmOptions(environment[key]); if (!tokens) return unboundedPlan(true);
    for (const token of tokens) { const value = propertyValue(token); if (value !== undefined) property = value; }
  }
  for (let index = 1; index < (argv || []).length; index += 1) {
    const token = String(argv[index] || ""); if (token === "--") break;
    const inline = propertyValue(token); if (inline !== undefined) property = inline;
    else if (["-D", "--system-prop"].includes(token)) {
      const next = String(argv[index + 1] || ""); if (next.startsWith(`${WORKERS_PROPERTY}=`)) property = next.slice(WORKERS_PROPERTY.length + 1);
      index += 1;
    }
  }
  return property === undefined ? null : numericPlan(property, maximum, true);
}
function propertyValue(token) {
  for (const prefix of [`-D${WORKERS_PROPERTY}=`, `--system-prop=${WORKERS_PROPERTY}=`]) if (String(token).startsWith(prefix)) return String(token).slice(prefix.length);
  return undefined;
}
function splitJvmOptions(value) {
  const result = []; let token = ""; let quote = ""; let escaped = false; let active = false;
  for (const char of String(value || "")) {
    if (escaped) { token += char; escaped = false; active = true; }
    else if (char === "\\" && quote !== "'") { escaped = true; active = true; }
    else if (quote) { if (char === quote) quote = ""; else token += char; active = true; }
    else if (["'", '"'].includes(char)) { quote = char; active = true; }
    else if (/\s/.test(char)) { if (active) { result.push(token); token = ""; active = false; } }
    else { token += char; active = true; }
  }
  if (quote || escaped) return null; if (active) result.push(token); return result;
}
function numericPlan(value, maximum, preserve) {
  const text = String(value ?? ""); if (!/^[+-]?\d+$/.test(text)) return invalidPlan(preserve);
  const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > GRADLE_INT_MAX) return invalidPlan(preserve);
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function invalidPlan(preserve) { return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true }; }
function unboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
