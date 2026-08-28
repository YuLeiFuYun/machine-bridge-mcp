import {
  normalizeWorkerSocketDisconnectEvidence,
  workerSocketDisconnectEvidence,
  type WorkerSocketDisconnectEvidence,
  type WorkerSocketDisconnectInput,
} from "./worker-socket-disconnect-evidence.ts";

const KEY = "worker-continuity-evidence";
const SCHEMA_VERSION = 2;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

type ContinuityStorage = Pick<DurableObjectStorage, "get" | "transaction">;
type ContinuityTransaction = Pick<DurableObjectTransaction, "get" | "put">;

export type WorkerContinuityEvidence = Readonly<{
  schema_version: 2;
  planned_drains: number;
  planned_drain_calls: number;
  last_planned_drain_at: string | null;
  socket_disconnects: number;
  unplanned_socket_disconnects: number;
  ready_socket_disconnects: number;
  unplanned_ready_socket_disconnects: number;
  last_socket_disconnect: WorkerSocketDisconnectEvidence | null;
  last_ready_socket_disconnect: WorkerSocketDisconnectEvidence | null;
  last_request_abort_at: string | null;
  last_stream_cancel_control_at: string | null;
}>;

export async function readWorkerContinuityEvidence(
  storage: Pick<DurableObjectStorage, "get">,
): Promise<WorkerContinuityEvidence> {
  return normalize(await storage.get(KEY));
}

export async function recordWorkerPlannedDrain(
  storage: ContinuityStorage,
  calls: number,
  now = Date.now(),
): Promise<boolean> {
  return update(storage, (state) => ({
    ...state,
    planned_drains: increment(state.planned_drains),
    planned_drain_calls: add(state.planned_drain_calls, calls),
    last_planned_drain_at: timestamp(now),
  }));
}

export async function recordWorkerSocketDisconnect(
  storage: ContinuityStorage,
  input: WorkerSocketDisconnectInput,
  now = Date.now(),
): Promise<boolean> {
  const planned = input.planned === true;
  const evidence = workerSocketDisconnectEvidence({ ...input, planned }, timestamp(now));
  return update(storage, (state) => ({
    ...state,
    socket_disconnects: increment(state.socket_disconnects),
    unplanned_socket_disconnects: planned ? state.unplanned_socket_disconnects : increment(state.unplanned_socket_disconnects),
    ready_socket_disconnects: evidence.was_ready ? increment(state.ready_socket_disconnects) : state.ready_socket_disconnects,
    unplanned_ready_socket_disconnects: evidence.was_ready && !planned
      ? increment(state.unplanned_ready_socket_disconnects) : state.unplanned_ready_socket_disconnects,
    last_socket_disconnect: evidence,
    last_ready_socket_disconnect: evidence.was_ready ? evidence : state.last_ready_socket_disconnect,
  }));
}

export async function recordWorkerClientCancellation(
  storage: ContinuityStorage,
  source: "request_abort" | "stream_cancel_control",
  now = Date.now(),
): Promise<boolean> {
  return update(storage, (state) => ({
    ...state,
    ...(source === "request_abort"
      ? { last_request_abort_at: timestamp(now) }
      : { last_stream_cancel_control_at: timestamp(now) }),
  }));
}

async function update(
  storage: ContinuityStorage,
  mutate: (state: WorkerContinuityEvidence) => WorkerContinuityEvidence,
): Promise<boolean> {
  try {
    await storage.transaction(async (transaction: ContinuityTransaction) => {
      const next = mutate(normalize(await transaction.get(KEY)));
      await transaction.put(KEY, next);
    });
    return true;
  } catch {
    return false;
  }
}

function normalize(value: unknown): WorkerContinuityEvidence {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const current = record.schema_version === SCHEMA_VERSION ? record : {};
  const compatible = record.schema_version === SCHEMA_VERSION || record.schema_version === 1 ? record : {};
  const last = normalizeWorkerSocketDisconnectEvidence(current.last_socket_disconnect);
  const lastReady = normalizeWorkerSocketDisconnectEvidence(current.last_ready_socket_disconnect);
  return {
    schema_version: SCHEMA_VERSION,
    planned_drains: count(compatible.planned_drains),
    planned_drain_calls: count(compatible.planned_drain_calls),
    last_planned_drain_at: optionalTimestamp(compatible.last_planned_drain_at),
    socket_disconnects: count(current.socket_disconnects),
    unplanned_socket_disconnects: count(current.unplanned_socket_disconnects),
    ready_socket_disconnects: count(current.ready_socket_disconnects),
    unplanned_ready_socket_disconnects: count(current.unplanned_ready_socket_disconnects),
    last_socket_disconnect: last,
    last_ready_socket_disconnect: lastReady?.was_ready === true ? lastReady : null,
    last_request_abort_at: optionalTimestamp(compatible.last_request_abort_at),
    last_stream_cancel_control_at: optionalTimestamp(compatible.last_stream_cancel_control_at),
  };
}

function increment(value: number): number { return value >= MAX_COUNT ? MAX_COUNT : value + 1; }
function add(value: number, extra: number): number { return Math.min(MAX_COUNT, value + Math.max(0, Math.floor(Number(extra) || 0))); }
function count(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function timestamp(value: number): string { return new Date(Number.isFinite(value) ? value : Date.now()).toISOString(); }
function optionalTimestamp(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
