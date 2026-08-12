import { normalizeAuthorityRevocation, type AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { randomToken } from "./oauth-state.ts";

export const AUTHORITY_REVOCATIONS_KEY = "authority-revocations";
const AUTHORITY_REVOCATION_SCHEMA = 1;
const MAX_AUTHORITY_REVOCATIONS = 1024;
const REVOCATION_ID = /^revoke_[A-Za-z0-9_-]{43}$/;
const QUEUE_FIELDS = new Set(["schema_version", "records"]);
const RECORD_FIELDS = new Set(["id", "account_id", "account_version", "client_id", "family_id", "queued_at"]);

type AuthorityRevocationRecord = Readonly<{
  id: string;
  account_id: string;
  account_version: number;
  client_id?: string;
  family_id?: string;
  queued_at: number;
}>;
type AuthorityRevocationQueue = { schema_version: 1; records: AuthorityRevocationRecord[] };
type RevocationStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type RevocationTransaction = Pick<DurableObjectTransaction, "get" | "put" | "delete">;

export async function putWithAuthorityRevocation(
  storage: RevocationStorage,
  writes: Readonly<Record<string, unknown>>,
  revocation?: AuthorityRevocation,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  return putWithAuthorityRevocations(storage, writes, revocation ? [revocation] : [], now);
}

export async function putWithAuthorityRevocations(
  storage: RevocationStorage,
  writes: Readonly<Record<string, unknown>>,
  revocations: readonly AuthorityRevocation[],
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (Object.hasOwn(writes, AUTHORITY_REVOCATIONS_KEY)) {
    throw new Error("protected writes cannot replace the authority revocation queue");
  }
  if (revocations.length === 0) {
    await storage.transaction(async (transaction) => {
      await writeEntries(transaction, writes);
    });
    return;
  }
  const candidates = revocations.map((revocation) => recordFromRevocation(
    normalizeAuthorityRevocationInput(revocation), randomToken("revoke"), now,
  ));
  await storage.transaction(async (transaction) => {
    const queue = await readQueue(transaction);
    for (const candidate of candidates) mergeRevocation(queue, candidate);
    await writeEntries(transaction, writes);
    await transaction.put(AUTHORITY_REVOCATIONS_KEY, queue);
  });
}

async function writeEntries(
  storage: Pick<RevocationTransaction, "put">,
  writes: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const [key, value] of Object.entries(writes)) await storage.put(key, value);
}

export async function authorityRevocations(storage: Pick<DurableObjectStorage, "get">): Promise<AuthorityRevocationRecord[]> {
  return [...(await readQueue(storage)).records];
}

export async function acknowledgeAuthorityRevocation(storage: RevocationStorage, revocationId: string): Promise<boolean> {
  if (!REVOCATION_ID.test(revocationId)) return false;
  return storage.transaction(async (transaction) => {
    const queue = await readQueue(transaction);
    const next = queue.records.filter((record) => record.id !== revocationId);
    if (next.length === queue.records.length) return false;
    if (next.length === 0) await transaction.delete(AUTHORITY_REVOCATIONS_KEY);
    else await transaction.put(AUTHORITY_REVOCATIONS_KEY, { schema_version: 1, records: next });
    return true;
  });
}

export function authorityRevocationWireMessage(record: AuthorityRevocationRecord): Record<string, unknown> {
  return {
    type: "authority_revoke",
    revocation_id: record.id,
    account_id: record.account_id,
    account_version: record.account_version,
    ...(record.client_id ? { client_id: record.client_id } : {}),
    ...(record.family_id ? { family_id: record.family_id } : {}),
  };
}

export function authorityRevocationAckId(value: unknown): string {
  const id = String(value || "");
  return REVOCATION_ID.test(id) ? id : "";
}

function normalizeAuthorityRevocationInput(value: AuthorityRevocation): AuthorityRevocation {
  const normalized = normalizeAuthorityRevocation({
    account_id: value.accountId,
    account_version: value.accountVersion,
    client_id: value.clientId,
    family_id: value.familyId,
  });
  if (!normalized) throw new Error("authority revocation is invalid");
  return normalized;
}

function recordFromRevocation(value: AuthorityRevocation, id: string, now: number): AuthorityRevocationRecord {
  return Object.freeze({
    id,
    account_id: value.accountId,
    account_version: value.accountVersion,
    ...(value.clientId ? { client_id: value.clientId } : {}),
    ...(value.familyId ? { family_id: value.familyId } : {}),
    queued_at: Math.max(1, Math.floor(now)),
  });
}

function mergeRevocation(queue: AuthorityRevocationQueue, candidate: AuthorityRevocationRecord): void {
  if (queue.records.some((record) => covers(record, candidate))) return;
  queue.records = queue.records.filter((record) => !covers(candidate, record));
  if (queue.records.length >= MAX_AUTHORITY_REVOCATIONS) {
    const collapsed = recordFromRevocation({
      accountId: candidate.account_id,
      accountVersion: candidate.account_version,
    }, candidate.id, candidate.queued_at);
    queue.records = queue.records.filter((record) => !sameAccountVersion(record, collapsed));
    if (!queue.records.some((record) => covers(record, collapsed))) queue.records.push(collapsed);
  } else {
    queue.records.push(candidate);
  }
  if (queue.records.length > MAX_AUTHORITY_REVOCATIONS) throw new Error("authority revocation queue is full");
}

function covers(left: AuthorityRevocationRecord, right: AuthorityRevocationRecord): boolean {
  if (!sameAccountVersion(left, right)) return false;
  if (!left.client_id) return true;
  if (left.client_id !== right.client_id) return false;
  return !left.family_id || left.family_id === right.family_id;
}

function sameAccountVersion(left: AuthorityRevocationRecord, right: AuthorityRevocationRecord): boolean {
  return left.account_id === right.account_id && left.account_version === right.account_version;
}

async function readQueue(storage: Pick<RevocationStorage | RevocationTransaction, "get">): Promise<AuthorityRevocationQueue> {
  const raw = await storage.get<unknown>(AUTHORITY_REVOCATIONS_KEY);
  if (raw === undefined) return { schema_version: AUTHORITY_REVOCATION_SCHEMA, records: [] };
  if (!validQueue(raw)) throw new Error("authority revocation state is invalid");
  return { schema_version: 1, records: raw.records.map((record) => Object.freeze({ ...record })) };
}

function validQueue(value: unknown): value is AuthorityRevocationQueue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const queue = value as Partial<AuthorityRevocationQueue>;
  return Object.keys(value).every((key) => QUEUE_FIELDS.has(key))
    && queue.schema_version === AUTHORITY_REVOCATION_SCHEMA
    && Array.isArray(queue.records)
    && queue.records.length <= MAX_AUTHORITY_REVOCATIONS
    && queue.records.every(validRecord);
}

function validRecord(value: unknown): value is AuthorityRevocationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => RECORD_FIELDS.has(key))
      || !REVOCATION_ID.test(String(record.id || "")) || !Number.isSafeInteger(record.queued_at) || Number(record.queued_at) <= 0) return false;
  return Boolean(normalizeAuthorityRevocation({
    account_id: record.account_id,
    account_version: record.account_version,
    client_id: record.client_id,
    family_id: record.family_id,
  }));
}
