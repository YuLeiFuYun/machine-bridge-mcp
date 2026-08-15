export function pytestWorkerPlan(argv, text, maximum = 1024) {
  const requested = optionValue(argv, text, ["-n", "--numprocesses"]);
  if (requested === null) return { jobs: 1, elastic: false, unbounded: false };
  if (requested === "0") return { jobs: 1, elastic: false, unbounded: false };
  if (/^\d+$/.test(requested)) return numericPlan(requested, maximum);
  if (!["auto", "logical"].includes(requested.toLowerCase())) return unboundedPlan();
  const cap = optionValue(argv, text, ["--maxprocesses"]);
  return cap !== null && /^\d+$/.test(cap) ? numericPlan(cap, maximum) : unboundedPlan();
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
function numericPlan(value, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? { jobs: parsed, elastic: false, unbounded: false } : unboundedPlan();
}
function unboundedPlan() { return { jobs: null, elastic: false, unbounded: true }; }
