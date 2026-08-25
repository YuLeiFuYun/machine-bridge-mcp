export const MAX_MANAGED_JOB_DEPENDENCIES = 16;

export function managedJobDependencyCount(value, fallback = 0, maximum = MAX_MANAGED_JOB_DEPENDENCIES) {
  const number = Number(value);
  if (!Number.isInteger(number)) return clampCount(fallback, maximum);
  return clampCount(number, maximum);
}

export function managedJobDependencyLabel(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

function clampCount(value, maximum) {
  const upper = Math.max(0, Math.min(MAX_MANAGED_JOB_DEPENDENCIES, Math.floor(Number(maximum) || 0)));
  return Math.max(0, Math.min(upper, Math.floor(Number(value) || 0)));
}
