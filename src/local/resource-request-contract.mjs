const FAMILY = /^[a-z][a-z0-9-]{0,47}$/;
const CONTENTION_KEY = /^[a-f0-9]{32}$/;
const RESOURCE_CLASSES = new Set(["adaptive", "cpu", "io", "mixed", "unbounded"]);
const PRIORITIES = new Set(["interactive", "ordinary", "background"]);

export function validateResourceRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("resource request is invalid");
  if (!FAMILY.test(String(request.family || "")) || !RESOURCE_CLASSES.has(request.resource_class)
      || !PRIORITIES.has(request.priority) || request.heavy !== true
      || typeof request.unbounded !== "boolean" || typeof request.serialize_project !== "boolean") {
    throw new Error("resource request contract is invalid");
  }
  finiteRange(request.cpu, 0, 1024, "cpu");
  finiteRange(request.io, 0, 1024, "io");
  finiteRange(request.memory_mb, 0, 16 * 1024 * 1024, "memory");
  finiteRange(request.disk_reserve_bytes, 0, 1024 ** 5, "disk reservation");
  if (request.compiler_jobs !== null && (!Number.isInteger(request.compiler_jobs) || request.compiler_jobs < 1 || request.compiler_jobs > 1024)) {
    throw new Error("resource request compiler jobs are invalid");
  }
  if (request.contention_key !== null && !CONTENTION_KEY.test(String(request.contention_key || ""))) {
    throw new Error("resource request contention key is invalid");
  }
  return request;
}

function finiteRange(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`resource request ${label} is invalid`);
  }
}
