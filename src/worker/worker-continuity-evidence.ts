const KEY = "worker-continuity-evidence";
const SCHEMA_VERSION = 1;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

type ContinuityStorage = Pick<DurableObjectStorage, "get" | "transaction">;
type ContinuityTransaction = Pick<DurableObjectTransaction, "get" | "put">;

type DisconnectEvidence = Readonly<{
  at: string;
  planned: boolean;
  kind: "close" | "error";
  close_code: number;
  was_clean: boolean;
}>;

export type WorkerContinuityEvidence = Readonly<{
  schema_version: 1;
  planned_drains: number;
  planned_drain_calls: number;
  last_planned_drain_at: string | null;
  socket_disconnects: number;
  unplanned_socket_disconnects: number;
  last_socket_disconnect: DisconnectEvidence | null;
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
  input: { planned: boolean; kind: "close" | "error"; closeCode?: number; wasClean?: boolean },
  now = Date.now(),
): Promise<boolean> {
  const planned = input.planned === true;
  return update(storage, (state) => ({
    ...state,
    socket_disconnects: increment(state.socket_disconnects),
    unplanned_socket_disconnects: planned ? state.unplanned_socket_disconnects : increment(state.unplanned_socket_disconnects),
    last_socket_disconnect: {
      at: timestamp(now), planned, kind: input.kind,
      close_code: normalizedCloseCode(input.closeCode), was_clean: input.wasClean === true,
    },
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
  const last = normalizeDisconnect(current.last_socket_disconnect);
  return {
    schema_version: SCHEMA_VERSION,
    planned_drains: count(current.planned_drains),
    planned_drain_calls: count(current.planned_drain_calls),
    last_planned_drain_at: optionalTimestamp(current.last_planned_drain_at),
    socket_disconnects: count(current.socket_disconnects),
    unplanned_socket_disconnects: count(current.unplanned_socket_disconnects),
    last_socket_disconnect: last,
    last_request_abort_at: optionalTimestamp(current.last_request_abort_at),
    last_stream_cancel_control_at: optionalTimestamp(current.last_stream_cancel_control_at),
  };
}

function normalizeDisconnect(value: unknown): DisconnectEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = optionalTimestamp(record.at);
  const kind = record.kind === "close" || record.kind === "error" ? record.kind : null;
  if (!at || !kind) return null;
  return { at, planned: record.planned === true, kind, close_code: normalizedCloseCode(record.close_code), was_clean: record.was_clean === true };
}

function increment(value: number): number { return value >= MAX_COUNT ? MAX_COUNT : value + 1; }
function add(value: number, extra: number): number { return Math.min(MAX_COUNT, value + Math.max(0, Math.floor(Number(extra) || 0))); }
function count(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function normalizedCloseCode(value: unknown): number { return Number.isInteger(value) && Number(value) >= 1000 && Number(value) <= 4999 ? Number(value) : 0; }
function timestamp(value: number): string { return new Date(Number.isFinite(value) ? value : Date.now()).toISOString(); }
function optionalTimestamp(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
