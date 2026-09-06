import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { AuthorizedToken } from "./access.ts";

export const JOB_MONITOR_CLAIM_TTL_MS = 5 * 60 * 1000;
export const MAX_JOB_MONITOR_CLAIMS = 128;
const STORE_KEY = "managed-job-monitor-claims-v1";
const STORE_SCHEMA = 1;
const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;
const MONITOR_ID = /^mcp_jm_[a-f0-9]{32}$/;
const STATES = new Set(["issued", "active", "claimed"]);
const STORE_FIELDS = new Set(["schema_version", "sequence", "claims"]);
const CLAIM_FIELDS = new Set([
  "jobId", "monitorId", "state", "expiresAt", "sequence", "owner_kind", "owner_account_id",
  "owner_account_version", "owner_client_id", "owner_family_id", "owner_role",
]);

type Claim = Readonly<{
  jobId: string; monitorId: string; state: "issued" | "active" | "claimed";
  expiresAt: number; sequence: number; owner_kind: "account";
  owner_account_id: string; owner_account_version: number;
  owner_client_id: string; owner_family_id: string; owner_role: string;
}>;
type State = { schema_version: 1; sequence: number; claims: Claim[] };
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type Transaction = Pick<DurableObjectTransaction, "get" | "put" | "delete">;

export class ManagedJobMonitorClaimStore {
  private readonly storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }

  issue(jobId: string, authorized: AuthorizedToken, now = Date.now()): Promise<string> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction); prune(state, now);
      state.claims = state.claims.filter((claim) => claim.jobId !== jobId || !matchesAuthorized(claim, authorized));
      while (state.claims.length >= MAX_JOB_MONITOR_CLAIMS) evictOldest(state);
      let monitorId = createMonitorId();
      while (state.claims.some((claim) => claim.monitorId === monitorId)) monitorId = createMonitorId();
      state.claims.push(makeClaim(jobId, monitorId, authorized, "issued", now, bumpSequence(state)));
      await transaction.put(STORE_KEY, state); return monitorId;
    });
  }

  activate(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): Promise<boolean> {
    return this.updateExact(jobId, monitorId, authorized, now, "issued", "active");
  }

  claim(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction); prune(state, now);
      const claim = exactClaim(state, jobId, monitorId, authorized);
      if (!claim || claim.state === "issued") return false;
      replaceClaim(state, claim, { ...claim, state: "claimed", expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: bumpSequence(state) });
      await transaction.put(STORE_KEY, state); return true;
    });
  }

  async has(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): Promise<boolean> {
    const state = await readState(this.storage); const claim = exactClaim(state, jobId, monitorId, authorized);
    return claim?.state === "claimed" && claim.expiresAt > now;
  }

  refresh(jobId: string, monitorId: string, authorized: AuthorizedToken, now = Date.now()): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction); const claim = exactClaim(state, jobId, monitorId, authorized);
      if (!claim || claim.state !== "claimed") return false;
      replaceClaim(state, claim, { ...claim, expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: bumpSequence(state) });
      await transaction.put(STORE_KEY, state); return true;
    });
  }

  cancelAuthority(revocation: AuthorityRevocation): Promise<number> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction); const before = state.claims.length;
      state.claims = state.claims.filter((claim) => !recordMatchesAuthorityRevocation(claim, revocation));
      const removed = before - state.claims.length;
      if (!removed) return 0;
      if (state.claims.length) await transaction.put(STORE_KEY, state); else await transaction.delete(STORE_KEY);
      return removed;
    });
  }

  private updateExact(
    jobId: string, monitorId: string, authorized: AuthorizedToken, now: number,
    required: Claim["state"], next: Claim["state"],
  ): Promise<boolean> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction); prune(state, now);
      const claim = exactClaim(state, jobId, monitorId, authorized);
      if (!claim || claim.state !== required) return false;
      replaceClaim(state, claim, { ...claim, state: next, expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence: bumpSequence(state) });
      await transaction.put(STORE_KEY, state); return true;
    });
  }
}

async function readState(storage: Pick<Storage | Transaction, "get">): Promise<State> {
  const raw = await storage.get<unknown>(STORE_KEY);
  if (raw === undefined) return { schema_version: 1, sequence: 0, claims: [] };
  if (!validState(raw)) throw new Error("managed-job monitor durable state is invalid");
  return { schema_version: 1, sequence: raw.sequence, claims: raw.claims.map((claim) => Object.freeze({ ...claim })) };
}
function validState(value: unknown): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<State>;
  return Object.keys(value).every((key) => STORE_FIELDS.has(key)) && state.schema_version === STORE_SCHEMA
    && Number.isSafeInteger(state.sequence) && Number(state.sequence) >= 0 && Array.isArray(state.claims)
    && state.claims.length <= MAX_JOB_MONITOR_CLAIMS && state.claims.every(validClaim)
    && validClaimSet(state.claims, Number(state.sequence));
}
function validClaimSet(claims: Claim[], sequence: number): boolean {
  const monitorIds = new Set(claims.map((claim) => claim.monitorId));
  const sequences = new Set(claims.map((claim) => claim.sequence));
  return monitorIds.size === claims.length && sequences.size === claims.length
    && claims.every((claim) => claim.sequence <= sequence);
}
function validClaim(value: unknown): value is Claim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Partial<Claim>;
  return Object.keys(value).every((key) => CLAIM_FIELDS.has(key)) && typeof claim.jobId === "string" && JOB_ID.test(claim.jobId)
    && typeof claim.monitorId === "string" && MONITOR_ID.test(claim.monitorId) && STATES.has(String(claim.state))
    && Number.isSafeInteger(claim.expiresAt) && Number(claim.expiresAt) > 0 && Number.isSafeInteger(claim.sequence) && Number(claim.sequence) > 0
    && claim.owner_kind === "account" && nonempty(claim.owner_account_id) && Number.isSafeInteger(claim.owner_account_version)
    && Number(claim.owner_account_version) > 0 && nonempty(claim.owner_client_id) && nonempty(claim.owner_family_id) && nonempty(claim.owner_role);
}
function makeClaim(jobId: string, monitorId: string, authorized: AuthorizedToken, state: Claim["state"], now: number, sequence: number): Claim {
  return Object.freeze({ jobId, monitorId, state, expiresAt: now + JOB_MONITOR_CLAIM_TTL_MS, sequence, owner_kind: "account",
    owner_account_id: authorized.accountId, owner_account_version: authorized.accountVersion,
    owner_client_id: authorized.clientId, owner_family_id: authorized.familyId, owner_role: authorized.role });
}
function exactClaim(state: State, jobId: string, monitorId: string, authorized: AuthorizedToken): Claim | undefined {
  return state.claims.find((claim) => claim.jobId === jobId && claim.monitorId === monitorId && matchesAuthorized(claim, authorized));
}
function matchesAuthorized(claim: Claim, authorized: AuthorizedToken): boolean {
  return claim.owner_account_id === authorized.accountId && claim.owner_account_version === authorized.accountVersion
    && claim.owner_client_id === authorized.clientId && claim.owner_family_id === authorized.familyId && claim.owner_role === authorized.role;
}
function prune(state: State, now: number): void { state.claims = state.claims.filter((claim) => claim.state === "claimed" || claim.expiresAt > now); }
function replaceClaim(state: State, previous: Claim, next: Claim): void { state.claims[state.claims.indexOf(previous)] = Object.freeze(next); }
function evictOldest(state: State): void { state.claims.splice(state.claims.reduce((best, claim, index, all) => claim.sequence < all[best].sequence ? index : best, 0), 1); }
function bumpSequence(state: State): number {
  if (state.sequence >= Number.MAX_SAFE_INTEGER - 1) { state.claims.sort((a, b) => a.sequence - b.sequence); state.claims = state.claims.map((claim, index) => Object.freeze({ ...claim, sequence: index + 1 })); state.sequence = state.claims.length; }
  return ++state.sequence;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function createMonitorId(): string {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return `mcp_jm_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
