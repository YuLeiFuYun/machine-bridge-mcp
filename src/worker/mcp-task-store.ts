import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";
import { isMcpTaskJobId, MCP_TASK_TTL_MS } from "../shared/mcp-task-contract.mjs";
import type { AuthorizedToken } from "./access.ts";
import { concatenate, decodeBase64, encodeBase64, encodeTaskResult, resultChunkKey, sha256 } from "./mcp-task-result-codec.ts";

export const MAX_MCP_TASKS = 128;
export const MAX_MCP_TASK_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_TASK_RESULT_BYTES_TOTAL = 32 * 1024 * 1024;
const RESULT_CHUNK_BYTES = 384 * 1024;
const STORE_KEY = "mcp-tasks-v1";
const STORE_SCHEMA = 1;
const STATUSES = new Set(["working", "input_required", "completed", "cancelled", "failed"]);
const STORE_FIELDS = new Set(["schema_version", "tasks"]);
const TASK_FIELDS = new Set([
  "taskId", "status", "statusMessage", "createdAt", "lastUpdatedAt", "expiresAt",
  "result_chunk_count", "result_bytes", "result_sha256", "reserved_result_bytes", "owner_kind",
  "owner_account_id", "owner_account_version", "owner_client_id", "owner_family_id", "owner_role",
]);

export type McpTaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";
export type McpTaskRecord = Readonly<{
  taskId: string;
  status: McpTaskStatus;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  expiresAt: number;
  result_chunk_count: number;
  result_bytes: number;
  result_sha256: string;
  reserved_result_bytes: number;
  owner_kind: "account";
  owner_account_id: string;
  owner_account_version: number;
  owner_client_id: string;
  owner_family_id: string;
  owner_role: string;
}>;
type State = { schema_version: 1; tasks: McpTaskRecord[] };
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type Transaction = Pick<DurableObjectTransaction, "get" | "put" | "delete">;

export class McpTaskStore {
  private readonly storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }

  create(taskId: string, authorized: AuthorizedToken, now = Date.now()): Promise<McpTaskRecord | null> {
    if (!isMcpTaskJobId(taskId)) return Promise.resolve(null);
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction);
      const before = state.tasks.length;
      await prune(transaction, state, now);
      const existing = state.tasks.find((task) => task.taskId === taskId);
      if (existing) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return matchesAuthorized(existing, authorized) ? existing : null;
      }
      if (state.tasks.length >= MAX_MCP_TASKS) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return null;
      }
      const retainedResultBytes = state.tasks.reduce((total, task) => total + task.result_bytes + task.reserved_result_bytes, 0);
      if (retainedResultBytes + MAX_MCP_TASK_RESULT_BYTES > MAX_MCP_TASK_RESULT_BYTES_TOTAL) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return null;
      }
      const timestamp = new Date(now).toISOString();
      const createdMs = Date.parse(timestamp);
      const expiresAt = createdMs + MCP_TASK_TTL_MS;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return null;
      }
      const task = makeTask(taskId, authorized, timestamp, expiresAt);
      state.tasks.push(task);
      await writeState(transaction, state);
      return task;
    });
  }

  get(taskId: string, authorized: AuthorizedToken, now = Date.now()): Promise<McpTaskRecord | null> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction);
      const before = state.tasks.length;
      await prune(transaction, state, now);
      const task = state.tasks.find((candidate) => candidate.taskId === taskId && matchesAuthorized(candidate, authorized));
      if (before !== state.tasks.length) await writeState(transaction, state);
      return task && task.expiresAt > now ? task : null;
    });
  }

  getResult(taskId: string, authorized: AuthorizedToken, now = Date.now()): Promise<Record<string, unknown> | null> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction);
      const before = state.tasks.length;
      await prune(transaction, state, now);
      const task = state.tasks.find((candidate) => candidate.taskId === taskId && matchesAuthorized(candidate, authorized));
      if (before !== state.tasks.length) await writeState(transaction, state);
      if (!task || task.status !== "completed" || task.result_chunk_count === 0) return null;
      const chunks: Uint8Array[] = [];
      for (let index = 0; index < task.result_chunk_count; index += 1) {
        const encoded = await transaction.get<string>(resultChunkKey(taskId, index));
        if (typeof encoded !== "string") throw new Error("MCP task result chunk is missing");
        const bytes = decodeBase64(encoded);
        if (!bytes) throw new Error("MCP task result chunk is invalid");
        chunks.push(bytes);
      }
      const serialized = concatenate(chunks, task.result_bytes);
      if (await sha256(serialized) !== task.result_sha256) throw new Error("MCP task result integrity check failed");
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(serialized)); }
      catch { throw new Error("MCP task result JSON is invalid"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP task result has an invalid shape");
      return value as Record<string, unknown>;
    });
  }

  updateStatus(taskId: string, authorized: AuthorizedToken, status: McpTaskStatus, statusMessage: string, result?: unknown, now = Date.now()): Promise<McpTaskRecord | null> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction);
      const before = state.tasks.length;
      await prune(transaction, state, now);
      const index = state.tasks.findIndex((candidate) => candidate.taskId === taskId && matchesAuthorized(candidate, authorized));
      if (index < 0) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return null;
      }
      const previous = state.tasks[index];
      if (!previous) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return null;
      }
      // A concurrent poll can finish after another poll already observed a terminal
      // state. Never let an older working snapshot move a task backwards. A completed
      // task may become failed only when no result was persisted and retrieval later
      // proves the backing job is gone; this records a result-delivery failure explicitly.
      const terminalResultMissing = previous.status === "completed"
        && previous.result_chunk_count === 0 && status === "failed";
      if (previous.status !== "working" && previous.status !== "input_required" && !terminalResultMissing) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return previous;
      }
      const normalizedMessage = statusMessage.slice(0, 512);
      if (previous.status === status && previous.statusMessage === normalizedMessage) {
        if (before !== state.tasks.length) await writeState(transaction, state);
        return previous;
      }
      let resultMetadata = {
        result_chunk_count: previous.result_chunk_count,
        result_bytes: previous.result_bytes,
        result_sha256: previous.result_sha256,
        reserved_result_bytes: previous.reserved_result_bytes,
      };
      if (status !== "working" && status !== "input_required") {
        resultMetadata = { result_chunk_count: 0, result_bytes: 0, result_sha256: "", reserved_result_bytes: 0 };
      }
      if (status === "completed" && result !== undefined) {
        const encoded = await encodeTaskResult(result);
        const currentResultBytes = state.tasks.reduce((total, task) => total + task.result_bytes + task.reserved_result_bytes, 0);
        const otherResultBytes = currentResultBytes - previous.result_bytes - previous.reserved_result_bytes;
        if (encoded && encoded.bytes.byteLength <= MAX_MCP_TASK_RESULT_BYTES
          && otherResultBytes + encoded.bytes.byteLength <= MAX_MCP_TASK_RESULT_BYTES_TOTAL) {
          const chunkCount = Math.ceil(encoded.bytes.byteLength / RESULT_CHUNK_BYTES);
          for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            const chunk = encoded.bytes.subarray(chunkIndex * RESULT_CHUNK_BYTES, Math.min((chunkIndex + 1) * RESULT_CHUNK_BYTES, encoded.bytes.byteLength));
            await transaction.put(resultChunkKey(taskId, chunkIndex), encodeBase64(chunk));
          }
          resultMetadata = {
            result_chunk_count: chunkCount, result_bytes: encoded.bytes.byteLength,
            result_sha256: encoded.sha256, reserved_result_bytes: 0,
          };
        }
      }
      const next = Object.freeze({
        ...previous, ...resultMetadata, status, statusMessage: normalizedMessage, lastUpdatedAt: new Date(now).toISOString(),
      });
      state.tasks[index] = next;
      await writeState(transaction, state);
      return next;
    });
  }

  cancelAuthority(revocation: AuthorityRevocation): Promise<number> {
    return this.storage.transaction(async (transaction) => {
      const state = await readState(transaction);
      const before = state.tasks.length;
      const removedTasks = state.tasks.filter((task) => recordMatchesAuthorityRevocation(task, revocation));
      state.tasks = state.tasks.filter((task) => !recordMatchesAuthorityRevocation(task, revocation));
      const removed = before - state.tasks.length;
      if (removed) {
        for (const task of removedTasks) await deleteTaskResult(transaction, task);
        await writeState(transaction, state);
      }
      return removed;
    });
  }
}

async function readState(storage: Pick<Storage | Transaction, "get">): Promise<State> {
  const raw = await storage.get<unknown>(STORE_KEY);
  if (raw === undefined) return { schema_version: 1, tasks: [] };
  if (!validState(raw)) throw new Error("MCP task durable state is invalid");
  return { schema_version: 1, tasks: raw.tasks.map((task) => Object.freeze({ ...task })) };
}

async function writeState(transaction: Transaction, state: State): Promise<void> {
  if (state.tasks.length) await transaction.put(STORE_KEY, state);
  else await transaction.delete(STORE_KEY);
}

function validState(value: unknown): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<State>;
  if (!Object.keys(value).every((key) => STORE_FIELDS.has(key)) || state.schema_version !== STORE_SCHEMA
    || !Array.isArray(state.tasks) || state.tasks.length > MAX_MCP_TASKS || !state.tasks.every(validTask)) return false;
  return new Set(state.tasks.map((task) => task.taskId)).size === state.tasks.length
    && state.tasks.reduce((total, task) => total + task.result_bytes + task.reserved_result_bytes, 0) <= MAX_MCP_TASK_RESULT_BYTES_TOTAL;
}

function validTask(value: unknown): value is McpTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<McpTaskRecord>;
  return Object.keys(value).every((key) => TASK_FIELDS.has(key))
    && isMcpTaskJobId(task.taskId)
    && typeof task.status === "string" && STATUSES.has(task.status)
    && typeof task.statusMessage === "string" && task.statusMessage.length <= 512
    && validTimestamp(task.createdAt) && validTimestamp(task.lastUpdatedAt)
    && Number.isSafeInteger(task.expiresAt) && Number(task.expiresAt) > 0
    && Number.isSafeInteger(task.result_chunk_count) && Number(task.result_chunk_count) >= 0
    && Number.isSafeInteger(task.result_bytes) && Number(task.result_bytes) >= 0 && Number(task.result_bytes) <= MAX_MCP_TASK_RESULT_BYTES
    && Number.isSafeInteger(task.reserved_result_bytes)
    && (Number(task.reserved_result_bytes) === 0 || Number(task.reserved_result_bytes) === MAX_MCP_TASK_RESULT_BYTES)
    && ((task.status === "working" || task.status === "input_required")
      ? Number(task.reserved_result_bytes) === MAX_MCP_TASK_RESULT_BYTES : Number(task.reserved_result_bytes) === 0)
    && (task.result_bytes === 0 ? task.result_chunk_count === 0 && task.result_sha256 === ""
      : task.result_chunk_count === Math.ceil(Number(task.result_bytes) / RESULT_CHUNK_BYTES)
        && typeof task.result_sha256 === "string" && /^[a-f0-9]{64}$/.test(task.result_sha256))
    && task.owner_kind === "account" && nonempty(task.owner_account_id)
    && Number.isSafeInteger(task.owner_account_version) && Number(task.owner_account_version) > 0
    && nonempty(task.owner_client_id) && nonempty(task.owner_family_id) && nonempty(task.owner_role);
}

function makeTask(taskId: string, authorized: AuthorizedToken, createdAt: string, expiresAt: number): McpTaskRecord {
  return Object.freeze({
    taskId, status: "working", statusMessage: "Accepted for execution.", createdAt, lastUpdatedAt: createdAt, expiresAt, owner_kind: "account",
    result_chunk_count: 0, result_bytes: 0, result_sha256: "", reserved_result_bytes: MAX_MCP_TASK_RESULT_BYTES,
    owner_account_id: authorized.accountId, owner_account_version: authorized.accountVersion,
    owner_client_id: authorized.clientId, owner_family_id: authorized.familyId, owner_role: authorized.role,
  });
}

function matchesAuthorized(task: McpTaskRecord, authorized: AuthorizedToken): boolean {
  return task.owner_account_id === authorized.accountId && task.owner_account_version === authorized.accountVersion
    && task.owner_client_id === authorized.clientId && task.owner_family_id === authorized.familyId
    && task.owner_role === authorized.role;
}

async function prune(transaction: Transaction, state: State, now: number): Promise<void> {
  const expired = state.tasks.filter((task) => task.expiresAt <= now);
  state.tasks = state.tasks.filter((task) => task.expiresAt > now);
  for (const task of expired) await deleteTaskResult(transaction, task);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

async function deleteTaskResult(transaction: Transaction, task: McpTaskRecord): Promise<void> {
  for (let index = 0; index < task.result_chunk_count; index += 1) {
    await transaction.delete(resultChunkKey(task.taskId, index));
  }
}
