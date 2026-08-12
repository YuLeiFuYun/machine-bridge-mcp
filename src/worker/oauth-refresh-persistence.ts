import type { ConsumedOAuthRefreshToken, OAuthRefreshStore } from "./oauth-state.ts";
import { hasOnlyRecordFields, OAUTH_CONSUMED_REFRESH_FIELDS, OAUTH_REFRESH_SHARD_FIELDS } from "./oauth-field-contract.ts";

export const OAUTH_REFRESH_STORE_KEY = "oauth-refresh";
const CONSUMED_SHARD_PREFIX = "oauth-refresh-consumed:";
const CONSUMED_SHARD_SCHEMA_VERSION = 1;
const CONSUMED_SHARD_COUNT = 8;
const MAX_CONSUMED_PER_SHARD = 1024;
const TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type OAuthRefreshPersistenceRead = Pick<DurableObjectStorage, "get">;
export type OAuthRefreshPersistenceWrite = Pick<DurableObjectStorage, "transaction">;

type ConsumedShard = {
  schema_version: number;
  records: Record<string, ConsumedOAuthRefreshToken>;
};

export interface LoadedConsumedRefreshShards {
  consumed: Record<string, ConsumedOAuthRefreshToken>;
  present: boolean;
  valid: boolean;
}

export async function loadConsumedRefreshShards(
  storage: OAuthRefreshPersistenceRead,
): Promise<LoadedConsumedRefreshShards> {
  const keys = consumedShardKeys();
  const raw = await storage.get<unknown>(keys);
  if (!(raw instanceof Map)) throw new Error("OAuth refresh shard multi-read returned an invalid result");
  const consumed: Record<string, ConsumedOAuthRefreshToken> = {};
  let present = false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = raw.get(key);
    if (value === undefined) continue;
    present = true;
    if (!validShardEnvelope(value) || Object.keys(value.records).length > MAX_CONSUMED_PER_SHARD) {
      return { consumed: {}, present, valid: false };
    }
    for (const [tokenHash, marker] of Object.entries(value.records)) {
      if (!TOKEN_HASH_PATTERN.test(tokenHash) || consumedShardIndex(tokenHash) !== index || Object.hasOwn(consumed, tokenHash)
          || !marker || typeof marker !== "object" || Array.isArray(marker)
          || !hasOnlyRecordFields(marker, OAUTH_CONSUMED_REFRESH_FIELDS)) {
        return { consumed: {}, present, valid: false };
      }
      consumed[tokenHash] = marker;
    }
  }
  return { consumed, present, valid: true };
}

export function oauthRefreshPersistenceEntries(
  store: OAuthRefreshStore,
): Readonly<Record<string, unknown>> {
  const shards = Array.from({ length: CONSUMED_SHARD_COUNT }, () => ({
    schema_version: CONSUMED_SHARD_SCHEMA_VERSION,
    records: {} as Record<string, ConsumedOAuthRefreshToken>,
  }));
  const counts = Array.from({ length: CONSUMED_SHARD_COUNT }, () => 0);
  for (const [tokenHash, marker] of Object.entries(store.consumed)) {
    if (!TOKEN_HASH_PATTERN.test(tokenHash)) throw new Error("OAuth refresh consumed-token key is invalid");
    const index = consumedShardIndex(tokenHash);
    counts[index] += 1;
    if (counts[index] > MAX_CONSUMED_PER_SHARD) throw new Error("OAuth refresh consumed-token shard capacity exceeded");
    shards[index].records[tokenHash] = marker;
  }
  const entries: Record<string, unknown> = {
    [OAUTH_REFRESH_STORE_KEY]: { ...store, consumed: {} },
  };
  const keys = consumedShardKeys();
  for (let index = 0; index < keys.length; index += 1) entries[keys[index]] = shards[index];
  return entries;
}

export async function saveOAuthRefreshStore(
  storage: OAuthRefreshPersistenceWrite,
  store: OAuthRefreshStore,
): Promise<void> {
  await storage.transaction((transaction) => writeOAuthRefreshPersistenceEntries(transaction, store));
}

export async function writeOAuthRefreshPersistenceEntries(
  storage: Pick<DurableObjectStorage, "put">,
  store: OAuthRefreshStore,
): Promise<void> {
  for (const [key, value] of Object.entries(oauthRefreshPersistenceEntries(store))) await storage.put(key, value);
}

export function mergeLegacyAndShardedConsumed(
  legacy: Readonly<Record<string, ConsumedOAuthRefreshToken>>,
  sharded: Readonly<Record<string, ConsumedOAuthRefreshToken>>,
): Record<string, ConsumedOAuthRefreshToken> | null {
  const merged: Record<string, ConsumedOAuthRefreshToken> = { ...legacy };
  for (const [tokenHash, marker] of Object.entries(sharded)) {
    if (Object.hasOwn(merged, tokenHash)) return null;
    merged[tokenHash] = marker;
  }
  return merged;
}

function consumedShardIndex(tokenHash: string): number {
  return Number.parseInt(tokenHash.slice(7, 8), 16) % CONSUMED_SHARD_COUNT;
}

function consumedShardKeys(): string[] {
  return Array.from({ length: CONSUMED_SHARD_COUNT }, (_, index) => `${CONSUMED_SHARD_PREFIX}${index.toString(16)}`);
}

function validShardEnvelope(value: unknown): value is ConsumedShard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const shard = value as Partial<ConsumedShard>;
  return hasOnlyRecordFields(value, OAUTH_REFRESH_SHARD_FIELDS)
    && shard.schema_version === CONSUMED_SHARD_SCHEMA_VERSION
    && Boolean(shard.records) && typeof shard.records === "object" && !Array.isArray(shard.records);
}
