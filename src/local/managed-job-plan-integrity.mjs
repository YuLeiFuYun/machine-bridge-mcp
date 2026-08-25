import { createHash } from "node:crypto";

export function managedJobPlanSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function assertManagedJobPlanIntegrity(plan, status, message = "managed job plan integrity check failed") {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error(message);
  const expected = String(status?.plan_sha256 || "");
  const actual = managedJobPlanSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error(message);
  return actual;
}
