export function goJobPlan(argv, environment = {}, maximum = 1024) { const inherited = goFlagsJobPlan(environment, maximum); return inherited?.fatal ? inherited : directGoPlan(argv, maximum) || inherited; }
export function goFlagsJobPlan(environment = {}, maximum = 1024) {
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "GOFLAGS")) return null;
  const tokens = splitGoFlags(environment.GOFLAGS); if (!tokens) return invalidPlan(true, true);
  let plan = null;
  for (const value of tokens) {
    if (["-p", "--p"].includes(value)) return invalidPlan(true, true);
    if (/^--?p=/.test(value)) { plan = numericPlan(value.slice(value.indexOf("=") + 1), maximum, true); if (plan.fatal) return plan; }
  }
  return plan;
}
function directGoPlan(argv, maximum) { let plan = null; let ambiguous = false; let packageList = false; let inPackages = false; const testMode = argv?.[1] === "test";
  for (let index = 2; index < (argv || []).length; index += 1) { const value = String(argv[index] || ""); if (["--", "-args", "--args"].includes(value)) break;
    if (!value.startsWith("-")) {
      if (!testMode) break; if (!packageList || inPackages) { packageList = true; inPackages = true; continue; }
      if (ambiguous) continue; break;
    }
    if (testMode && inPackages) inPackages = false; let current = null;
    if (["-p", "--p"].includes(value)) { if (ambiguous) return unboundedPlan(false); current = numericPlan(argv[index + 1], maximum, false); index += 1; }
    else if (/^--?p=/.test(value)) { if (ambiguous) return unboundedPlan(false); current = numericPlan(value.slice(value.indexOf("=") + 1), maximum, false); }
    else if (/^-p[-+]?\d/.test(value)) { if (ambiguous) return unboundedPlan(false); current = invalidPlan(false, true); }
    else if (!value.includes("=")) ambiguous = true;
    if (current?.fatal) return current; if (current) plan = current;
  }
  return plan;
}
function splitGoFlags(value) {
  let text = String(value || ""); const result = [];
  while (text.length) {
    text = text.replace(/^[ \t\n\r]+/, ""); if (!text) break;
    if (text[0] === "'" || text[0] === '"') {
      const quote = text[0]; const end = text.indexOf(quote, 1); if (end < 0) return null;
      result.push(text.slice(1, end)); text = text.slice(end + 1); continue;
    }
    const match = /^[^ \t\n\r]+/.exec(text); result.push(match[0]); text = text.slice(match[0].length);
  }
  return result;
}
function numericPlan(value, maximum, preserve) { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) return invalidPlan(preserve, true);
  if (parsed <= 0) return invalidPlan(preserve, false); return parsed <= maximum ? { jobs: parsed, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function invalidPlan(preserve, fatal) { return { jobs: null, elastic: false, unbounded: false, preserve, invalid: true, fatal }; }
function unboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
