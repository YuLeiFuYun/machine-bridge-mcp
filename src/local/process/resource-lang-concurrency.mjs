import { availableParallelism } from "node:os";

export function goJobPlan(argv, environment = {}, maximum = 1024) {
  const inherited = goFlagsJobPlan(environment, maximum);
  return inherited?.fatal ? inherited : directGoPlan(argv, maximum) || inherited;
}

export function goFlagsJobPlan(environment = {}, maximum = 1024) {
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "GOFLAGS")) return null;
  const tokens = splitGoFlags(environment.GOFLAGS);
  if (!tokens) return goInvalidPlan(true, true);
  let plan = null;
  for (const value of tokens) {
    if (["-p", "--p"].includes(value)) return goInvalidPlan(true, true);
    if (/^--?p=/.test(value)) {
      plan = goNumericPlan(value.slice(value.indexOf("=") + 1), maximum, true);
      if (plan.fatal) return plan;
    }
  }
  return plan;
}

function directGoPlan(argv, maximum) {
  let plan = null;
  let ambiguous = false;
  let packageList = false;
  let inPackages = false;
  const testMode = argv?.[1] === "test";
  for (let index = 2; index < (argv || []).length; index += 1) {
    const value = String(argv[index] || "");
    if (["--", "-args", "--args"].includes(value)) break;
    if (!value.startsWith("-")) {
      if (!testMode) break;
      if (!packageList || inPackages) {
        packageList = true;
        inPackages = true;
        continue;
      }
      if (ambiguous) continue;
      break;
    }
    if (testMode && inPackages) inPackages = false;
    let current = null;
    if (["-p", "--p"].includes(value)) {
      if (ambiguous) return goUnboundedPlan(false);
      current = goNumericPlan(argv[index + 1], maximum, false);
      index += 1;
    } else if (/^--?p=/.test(value)) {
      if (ambiguous) return goUnboundedPlan(false);
      current = goNumericPlan(value.slice(value.indexOf("=") + 1), maximum, false);
    } else if (/^-p[-+]?\d/.test(value)) {
      if (ambiguous) return goUnboundedPlan(false);
      current = goInvalidPlan(false, true);
    } else if (!value.includes("=")) {
      ambiguous = true;
    }
    if (current?.fatal) return current;
    if (current) plan = current;
  }
  return plan;
}

function splitGoFlags(value) {
  let text = String(value || "");
  const result = [];
  while (text.length) {
    text = text.replace(/^[ \t\n\r]+/, "");
    if (!text) break;
    if (text[0] === "'" || text[0] === '"') {
      const quote = text[0];
      const end = text.indexOf(quote, 1);
      if (end < 0) return null;
      result.push(text.slice(1, end));
      text = text.slice(end + 1);
      continue;
    }
    const match = /^[^ \t\n\r]+/.exec(text);
    result.push(match[0]);
    text = text.slice(match[0].length);
  }
  return result;
}

function goNumericPlan(value, maximum, preserve) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return goInvalidPlan(preserve, true);
  if (parsed <= 0) return goInvalidPlan(preserve, false);
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : goUnboundedPlan(preserve);
}

function goInvalidPlan(preserve, fatal) {
  return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true, fatal };
}

function goUnboundedPlan(preserve) {
  return { jobs: null, elastic: false, unbounded: true, preserve };
}
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
  if (values.length > 1) return gradleInvalidPlan(false);
  return values.length ? gradleNumericPlan(values[0], maximum, false) : null;
}

function gradlePropertyPlan(argv, environment, maximum) {
  let property;
  for (const key of ["JAVA_OPTS", "GRADLE_OPTS"]) {
    if (!Object.prototype.hasOwnProperty.call(environment || {}, key)) continue;
    const tokens = splitJvmOptions(environment[key]); if (!tokens) return gradleUnboundedPlan(true);
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
  return property === undefined ? null : gradleNumericPlan(property, maximum, true);
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

function gradleNumericPlan(value, maximum, preserve) {
  const text = String(value ?? ""); if (!/^[+-]?\d+$/.test(text)) return gradleInvalidPlan(preserve);
  const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > GRADLE_INT_MAX) return gradleInvalidPlan(preserve);
  return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : gradleUnboundedPlan(preserve);
}

function gradleInvalidPlan(preserve) { return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true }; }

function gradleUnboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
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
    ? { jobs, elastic: false, unbounded: false, preserve } : mavenUnboundedPlan(preserve);
}

function multiplierPlan(value, maximum, preserve) {
  const multiplier = Number(String(value).slice(0, -1));
  if (!Number.isFinite(multiplier) || multiplier <= 0) return mavenUnboundedPlan(preserve);
  const jobs = Math.max(1, Math.trunc(multiplier * availableParallelism()));
  return jobs <= maximum ? { jobs, elastic: false, unbounded: false, preserve } : mavenUnboundedPlan(preserve);
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

function mavenUnboundedPlan(preserve = false) { return { jobs: null, elastic: false, unbounded: true, preserve }; }

function words(value) { return String(value || "").trim().split(/\s+/).filter(Boolean); }
export function pytestWorkerPlan(argv, text, maximum = 1024) {
  const requested = optionValue(argv, text, ["-n", "--numprocesses"]);
  if (requested === null) return { jobs: 1, elastic: false, unbounded: false };
  if (requested === "0") return { jobs: 1, elastic: false, unbounded: false };
  if (/^\d+$/.test(requested)) return pytestNumericPlan(requested, maximum);
  if (!["auto", "logical"].includes(requested.toLowerCase())) return pytestUnboundedPlan();
  const cap = optionValue(argv, text, ["--maxprocesses"]);
  return cap !== null && /^\d+$/.test(cap) ? pytestNumericPlan(cap, maximum) : pytestUnboundedPlan();
}

function optionValue(argv, text, flags) {
  for (let index = 1; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    for (const flag of flags) {
      if (value === flag) return String(argv[index + 1] || "").trim();
      if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1).trim();
      if (flag === "-n" && value.startsWith("-n") && value.length > 2) return value.slice(2).trim();
    }
  }
  if (flags.includes("-n")) {
    const compact = /(?:^|\s)-n([^\s]+)/i.exec(text);
    if (compact) return compact[1];
  }
  const names = flags.map((flag) => flag.replace(/^-+/, "")).join("|");
  const match = new RegExp(`(?:^|\\s)--?(?:${names})[=\\s]+([^\\s]+)`, "i").exec(text);
  return match ? match[1] : null;
}

function pytestNumericPlan(value, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? { jobs: parsed, elastic: false, unbounded: false } : pytestUnboundedPlan();
}

function pytestUnboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
