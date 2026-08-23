import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { WorkerToolError } from "./errors.ts";
import { MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, pendingReadJobCallsForAccount } from "./pending-call-capacity.ts";

export type ReadyWaiterAuthority = Readonly<{
  accountId: string;
  accountVersion: number;
  clientId: string;
  familyId: string;
}>;

export type ReadyWaiterPolicyRecord = Readonly<{
  tool: string;
  owner_kind?: "account";
  owner_account_id?: string;
  owner_account_version?: number;
  owner_client_id?: string;
  owner_family_id?: string;
}>;

export function readyWaiterAuthorityFields(authority?: ReadyWaiterAuthority): Record<string, unknown> {
  if (!authority?.accountId) return {};
  return {
    owner_kind: "account",
    owner_account_id: authority.accountId,
    owner_account_version: authority.accountVersion,
    owner_client_id: authority.clientId,
    owner_family_id: authority.familyId,
  };
}

export function assertReadyWaiterReadJobCapacity(
  waiters: Iterable<ReadyWaiterPolicyRecord>,
  tool: string,
  authority?: ReadyWaiterAuthority,
  activeReadJobCallsForAccount = 0,
): void {
  if (tool !== "read_job" || !authority?.accountId) return;
  const waiting = pendingReadJobCallsForAccount(waiters, authority.accountId);
  const active = Number.isFinite(activeReadJobCallsForAccount)
    ? Math.max(0, Math.floor(activeReadJobCallsForAccount)) : 0;
  if (active + waiting < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT) return;
  throw new WorkerToolError(
    "limit_exceeded",
    `managed-job read capacity reached for this account (${MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT})`,
    true,
  );
}

export function readyWaiterMatchesRevocation(
  waiter: ReadyWaiterPolicyRecord,
  revocation: AuthorityRevocation,
): boolean {
  return recordMatchesAuthorityRevocation(waiter, revocation);
}
