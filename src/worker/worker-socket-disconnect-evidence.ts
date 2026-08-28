export type WorkerSocketDisconnectEvidence = Readonly<{
  at: string;
  planned: boolean;
  kind: "close" | "error";
  close_code: number;
  was_clean: boolean;
  role: "candidate" | "probing" | "daemon" | null;
  was_ready: boolean;
  connected_at: string | null;
}>;

export type WorkerSocketDisconnectInput = Readonly<{
  planned: boolean;
  kind: "close" | "error";
  closeCode?: number;
  wasClean?: boolean;
  role?: "candidate" | "probing" | "daemon" | "expired";
  connectedAt?: string;
}>;

export function workerSocketDisconnectEvidence(input: WorkerSocketDisconnectInput, at: string): WorkerSocketDisconnectEvidence {
  const role = normalizedRole(input.role);
  return {
    at,
    planned: input.planned === true,
    kind: input.kind,
    close_code: normalizedCloseCode(input.closeCode),
    was_clean: input.wasClean === true,
    role,
    was_ready: role === "daemon",
    connected_at: optionalTimestamp(input.connectedAt),
  };
}

export function normalizeWorkerSocketDisconnectEvidence(value: unknown): WorkerSocketDisconnectEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = optionalTimestamp(record.at);
  const kind = record.kind === "close" || record.kind === "error" ? record.kind : null;
  if (!at || !kind) return null;
  const role = normalizedRole(record.role);
  return {
    at, planned: record.planned === true, kind,
    close_code: normalizedCloseCode(record.close_code), was_clean: record.was_clean === true,
    role, was_ready: role === "daemon" && record.was_ready === true,
    connected_at: optionalTimestamp(record.connected_at),
  };
}

function normalizedCloseCode(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1000 && Number(value) <= 4999 ? Number(value) : 0;
}
function normalizedRole(value: unknown): "candidate" | "probing" | "daemon" | null {
  return value === "candidate" || value === "probing" || value === "daemon" ? value : null;
}
function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
