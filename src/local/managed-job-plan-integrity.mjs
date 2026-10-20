// @ts-check
import { createHash } from "node:crypto";

/** @param {unknown} plan @returns {string} */
export function managedJobPlanSha256(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/**
 * @param {unknown} plan
 * @param {{ plan_sha256?: unknown }} [status]
 * @param {string} [message]
 * @returns {string}
 */
export function assertManagedJobPlanIntegrity(plan, status, message = "managed job plan integrity check failed") {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error(message);
  const expected = String(status?.plan_sha256 || "");
  const actual = managedJobPlanSha256(plan);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error(message);
  return actual;
}
