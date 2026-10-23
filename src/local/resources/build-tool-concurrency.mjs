import { availableParallelism } from "node:os";

export function parseArgvJobs(argv, flags = ["-j", "--jobs"], maximum = 1024) {
  for (let index = 1; index < (argv || []).length; index += 1) {
    const current = String(argv[index]);
    if (current === "--") break;
    for (const flag of flags) {
      if (current === flag) {
        return parseNumericPlan(argv[index + 1], maximum, false);
      }
      if (current.startsWith(`${flag}=`)) {
        return parseNumericPlan(current.slice(flag.length + 1), maximum, false);
      }
      if (current.startsWith(flag) && current.length > flag.length && flag.length === 2) {
        return parseNumericPlan(current.slice(flag.length), maximum, false);
      }
    }
  }
  return null;
}

export function parseNumericPlan(value, maximum = 1024, preserve = false) {
  const text = String(value ?? "").trim();
  const cores = availableParallelism();
  if (text === "default") return { jobs: cores, elastic: false, unbounded: false, preserve };
  if (!/^-?\d+$/.test(text)) return { jobs: null, elastic: false, unbounded: true, preserve };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed === 0) return { jobs: null, elastic: false, unbounded: true, preserve };
  const jobs = parsed < 0 ? cores + parsed : parsed;
  return Number.isSafeInteger(jobs) && jobs >= 1 && jobs <= maximum
    ? { jobs, elastic: false, unbounded: false, preserve }
    : { jobs: null, elastic: false, unbounded: true, preserve };
}
