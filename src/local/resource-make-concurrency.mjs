export function makeCommandJobPlan(argv, maximum = 1024) {
  return makeTokensPlan((argv || []).slice(1).map(String), maximum, false).plan;
}

export function makeFlagsJobPlan(environment = {}, maximum = 1024) {
  let plan = null; let jobserver = false;
  for (const key of ["GNUMAKEFLAGS", "MAKEFLAGS"]) {
    if (!Object.prototype.hasOwnProperty.call(environment || {}, key)) continue;
    const tokens = words(environment[key]);
    if (tokens[0] && !tokens[0].startsWith("-") && !tokens[0].includes("=")) tokens[0] = `-${tokens[0]}`;
    const parsed = makeTokensPlan(tokens, maximum, true);
    if (parsed.plan) plan = parsed.plan;
    jobserver ||= parsed.jobserver;
  }
  return plan || (jobserver ? unboundedPlan(true) : null);
}

function makeTokensPlan(tokens, maximum, preserve) {
  let plan = null; let jobserver = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (["-j", "--jobs"].includes(current)) {
      const next = tokens[index + 1];
      if (/^\d+$/.test(next || "")) { plan = numericPlan(next, maximum, preserve); index += 1; }
      else plan = unboundedPlan(preserve);
    } else if (current.startsWith("--jobs=")) plan = numericPlan(current.slice("--jobs=".length), maximum, preserve);
    else if (/^-[A-Za-z]*j/.test(current)) plan = compactPlan(current, maximum, preserve);
    if (current.startsWith("--jobserver-auth=") || current.startsWith("--jobserver-fds=")) jobserver = true;
  }
  return { plan, jobserver };
}
function compactPlan(value, maximum, preserve) {
  const suffix = /^-[A-Za-z]*j(.*)$/.exec(value)?.[1] ?? "";
  return suffix ? numericPlan(suffix, maximum, preserve) : unboundedPlan(preserve);
}
function numericPlan(value, maximum, preserve) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? { jobs: parsed, elastic: false, unbounded: false, preserve } : unboundedPlan(preserve);
}
function unboundedPlan(preserve) { return { jobs: null, elastic: false, unbounded: true, preserve }; }
function words(value) { return String(value || "").trim().split(/\s+/).filter(Boolean); }
