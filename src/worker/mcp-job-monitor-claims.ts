import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { AuthorizedToken } from "./access.ts";
import { WorkerToolError } from "./errors.ts";
import { verifyManagedJobCapability } from "./managed-job-capability.ts";
import { JOB_MONITOR_CLAIM_TTL_MS, ManagedJobMonitorClaimStore } from "./mcp-job-monitor-store.ts";

export { JOB_MONITOR_CLAIM_TTL_MS, ManagedJobMonitorClaimStore } from "./mcp-job-monitor-store.ts";
export const JOB_MONITOR_ID_PATTERN = "^mcp_jm_[a-f0-9]{32}$";
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const MONITOR_ID = /^mcp_jm_[a-f0-9]{32}$/;
export type ManagedJobMonitorCoordinationOperation = "issue" | "claim_probe" | "revocation_cleanup";
export type ManagedJobMonitorCoordinationFailureObserver = (operation: ManagedJobMonitorCoordinationOperation, error: unknown) => void;

export function issueManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, jobId: string, authorized: AuthorizedToken,
): Promise<string> {
  return store.issue(jobId, authorized);
}

export async function issueManagedJobMonitorIfAvailable(
  store: ManagedJobMonitorClaimStore, jobId: string, authorized: AuthorizedToken,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<string | null> {
  try { return await store.issue(jobId, authorized); }
  catch (error) { observeCoordinationFailure(observeFailure, "issue", error); return null; }
}

export function activateManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, jobId: string, monitorId: string, authorized: AuthorizedToken,
): Promise<boolean> {
  return store.activate(jobId, monitorId, authorized);
}

export async function claimManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!jobId || !monitorId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  if (!await store.claim(jobId, monitorId, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor render instance is not active", false, { side_effects_started: false });
  }
  return { claimed: true, expires_in_ms: JOB_MONITOR_CLAIM_TTL_MS };
}

export function hasManagedJobMonitorClaim(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
): Promise<boolean> {
  return typeof jobId === "string" && JOB_ID.test(jobId) && validManagedJobMonitorId(monitorId)
    ? store.has(jobId, monitorId, authorized) : Promise.resolve(false);
}

export async function hasManagedJobMonitorClaimIfAvailable(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<boolean> {
  try { return await hasManagedJobMonitorClaim(store, jobId, monitorId, authorized); }
  catch (error) { observeCoordinationFailure(observeFailure, "claim_probe", error); return false; }
}

export function refreshManagedJobMonitorClaim(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
): Promise<boolean> {
  return typeof jobId === "string" && JOB_ID.test(jobId) && validManagedJobMonitorId(monitorId)
    ? store.refresh(jobId, monitorId, authorized) : Promise.resolve(false);
}

export function cancelManagedJobMonitorClaims(
  store: ManagedJobMonitorClaimStore, revocation: AuthorityRevocation,
): Promise<number> {
  return store.cancelAuthority(revocation);
}

export async function cancelManagedJobMonitorClaimsIfAvailable(
  store: ManagedJobMonitorClaimStore, revocation: AuthorityRevocation,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<number> {
  try { return await store.cancelAuthority(revocation); }
  catch (error) { observeCoordinationFailure(observeFailure, "revocation_cleanup", error); return 0; }
}

export function validManagedJobMonitorId(value: unknown): value is string {
  return typeof value === "string" && MONITOR_ID.test(value);
}

function observeCoordinationFailure(
  observer: ManagedJobMonitorCoordinationFailureObserver | undefined,
  operation: ManagedJobMonitorCoordinationOperation,
  error: unknown,
): void {
  try { observer?.(operation, error); } catch { /* auxiliary telemetry must not become monitor authority */ }
}
