import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { AuthorizedToken } from "./access.ts";
import { WorkerToolError } from "./errors.ts";
import { verifyManagedJobCapability } from "./managed-job-capability.ts";

export const JOB_MONITOR_CLAIM_TTL_MS = 5 * 60 * 1000;
export const JOB_MONITOR_ID_PATTERN = "^mcp_jm_[a-f0-9]{32}$";
const MAX_JOB_MONITOR_CLAIMS = 128;
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const MONITOR_ID = /^mcp_jm_[a-f0-9]{32}$/;
type Claim = Readonly<{
  jobId: string; monitorId: string; state: "issued" | "active" | "claimed";
  expiresAt: number; sequence: number; owner_kind: "account";
  owner_account_id: string; owner_account_version: number;
  owner_client_id: string; owner_family_id: string; owner_role: string;
}>;
export class ManagedJobMonitorClaims {
  private readonly claims = new Map<string, Claim>();
  private sequence = 0;

  issue(jobId: string, authorized: AuthorizedToken, now = Date.now()): string {
    this.prune(now);
    while (this.claims.size >= MAX_JOB_MONITOR_CLAIMS) this.evictOldest();
    let monitorId = createMonitorId();
    let key = claimKey(jobId, monitorId, authorized);
    while (this.claims.has(key)) { monitorId = createMonitorId(); key = claimKey(jobId, monitorId, authorized); }
    this.claims.set(key, {
      jobId, monitorId, state: "issued", expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: ++this.sequence,
      owner_kind: "account", owner_account_id: authorized.accountId, owner_account_version: authorized.accountVersion,
      owner_client_id: authorized.clientId, owner_family_id: authorized.familyId, owner_role: authorized.role,
    });
    return monitorId;
  }

  activate(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): boolean {
    this.prune(now);
    const key = claimKey(jobId, monitorId, authorized); const issued = this.claims.get(key);
    if (!issued || issued.state !== "issued") return false;
    this.claims.set(key, { ...issued, state: "active", expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: ++this.sequence });
    return true;
  }

  claim(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): Record<string, unknown> | null {
    this.prune(now);
    const key = claimKey(jobId, monitorId, authorized); const issued = this.claims.get(key);
    if (!issued || issued.state === "issued") return null;
    this.claims.set(key, { ...issued, state: "claimed", expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: ++this.sequence });
    return { claimed: true, expires_in_ms: JOB_MONITOR_CLAIM_TTL_MS };
  }

  has(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): boolean {
    this.prune(now);
    return this.claims.get(claimKey(jobId, monitorId, authorized))?.state === "claimed";
  }

  cancelAuthority(revocation: AuthorityRevocation): number {
    let removed = 0;
    for (const [key, claim] of this.claims) {
      if (!recordMatchesAuthorityRevocation(claim, revocation)) continue;
      this.claims.delete(key); removed += 1;
    }
    return removed;
  }

  private prune(now: number): void {
    for (const [key, claim] of this.claims) if (claim.expiresAt <= now) this.claims.delete(key);
  }

  private evictOldest(): void {
    let oldestKey = ""; let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [key, claim] of this.claims) {
      if (claim.sequence >= oldestSequence) continue;
      oldestSequence = claim.sequence; oldestKey = key;
    }
    if (oldestKey) this.claims.delete(oldestKey);
  }
}

const hostedClaims = new WeakMap<object, ManagedJobMonitorClaims>();
export function issueManagedJobMonitor(scope: object, jobId: string, authorized: AuthorizedToken): string {
  return claimsFor(scope).issue(jobId, authorized);
}
export function activateManagedJobMonitor(scope: object, jobId: string, monitorId: string, authorized: AuthorizedToken): boolean {
  return claimsFor(scope).activate(jobId, monitorId, authorized);
}
export async function claimManagedJobMonitor(
  scope: object, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!jobId || !monitorId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  const claim = claimsFor(scope).claim(jobId, monitorId, authorized);
  if (!claim) throw new WorkerToolError("invalid_request", "managed-job monitor render instance is not active", false, { side_effects_started: false });
  return claim;
}
export function hasManagedJobMonitorClaim(scope: object, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken): boolean {
  return typeof jobId === "string" && JOB_ID.test(jobId) && validManagedJobMonitorId(monitorId)
    && claimsFor(scope).has(jobId, monitorId, authorized);
}
export function cancelManagedJobMonitorClaims(scope: object, revocation: AuthorityRevocation): number {
  return claimsFor(scope).cancelAuthority(revocation);
}
function claimsFor(scope: object): ManagedJobMonitorClaims {
  let claims = hostedClaims.get(scope);
  if (!claims) { claims = new ManagedJobMonitorClaims(); hostedClaims.set(scope, claims); }
  return claims;
}
function claimKey(jobId: string, monitorId: string, authorized: AuthorizedToken): string {
  return [jobId, monitorId, authorized.accountId, authorized.accountVersion, authorized.clientId, authorized.familyId, authorized.role].join("\0");
}
export function validManagedJobMonitorId(value: unknown): value is string {
  return typeof value === "string" && MONITOR_ID.test(value);
}
function createMonitorId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `mcp_jm_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
