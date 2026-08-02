export type PendingStreamTransform = {
  kind: "project_overview";
  account_id: string;
  account_version: number;
  role: "owner" | "operator" | "editor" | "reviewer";
};

export type PendingStreamCall = {
  call_id: string;
  daemon_instance_id: string;
  connection_id: string;
  client_request_key?: string;
  request_fingerprint?: string;
  tool: string;
  state: "attached" | "detached";
  started_at: number;
  operation_deadline_at: number;
  remaining_timeout_ms: number;
  reconnect_deadline_at?: number;
  transform?: PendingStreamTransform;
};

const CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{43}$/;
const CONNECTION_ID_PATTERN = /^connection_[A-Za-z0-9_-]{43}$/;
const DAEMON_INSTANCE_PATTERN = /^daemon_[A-Za-z0-9_-]{16,96}$/;

export function validPendingStreamCall(value: unknown): value is PendingStreamCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as Partial<PendingStreamCall>;
  const transform = call.transform;
  const validTransform = transform === undefined || (
    transform.kind === "project_overview"
    && typeof transform.account_id === "string"
    && transform.account_id.length > 0
    && transform.account_id.length <= 160
    && Number.isSafeInteger(transform.account_version)
    && transform.account_version! >= 1
    && ["owner", "operator", "editor", "reviewer"].includes(String(transform.role))
  );
  return typeof call.call_id === "string" && CALL_ID_PATTERN.test(call.call_id)
    && typeof call.daemon_instance_id === "string" && DAEMON_INSTANCE_PATTERN.test(call.daemon_instance_id)
    && typeof call.connection_id === "string" && CONNECTION_ID_PATTERN.test(call.connection_id)
    && (call.client_request_key === undefined || (
      typeof call.client_request_key === "string"
      && call.client_request_key.length > 0
      && call.client_request_key.length <= 1024
    ))
    && (call.request_fingerprint === undefined || (
      typeof call.request_fingerprint === "string" && /^[a-f0-9]{64}$/.test(call.request_fingerprint)
    ))
    && typeof call.tool === "string" && call.tool.length > 0 && call.tool.length <= 128
    && (call.state === "attached" || call.state === "detached")
    && Number.isSafeInteger(call.started_at) && call.started_at! >= 0
    && Number.isSafeInteger(call.operation_deadline_at) && call.operation_deadline_at! > call.started_at!
    && Number.isSafeInteger(call.remaining_timeout_ms) && call.remaining_timeout_ms! >= 1
    && (call.reconnect_deadline_at === undefined || (
      Number.isSafeInteger(call.reconnect_deadline_at)
      && call.reconnect_deadline_at! >= call.started_at!
    ))
    && (call.state === "attached" ? call.reconnect_deadline_at === undefined : call.reconnect_deadline_at !== undefined)
    && validTransform;
}

export function pendingCallIdentityConflict(
  record: Readonly<{ client_request_key?: string; request_fingerprint?: string; tool?: string }>,
  input: Readonly<{ clientRequestKey?: string; requestFingerprint?: string; tool: string }>,
): string | undefined {
  if (input.clientRequestKey && record.client_request_key && record.client_request_key !== input.clientRequestKey) {
    return "resumable MCP request key changed before activation";
  }
  if (input.requestFingerprint && record.request_fingerprint && record.request_fingerprint !== input.requestFingerprint) {
    return "resumable MCP request fingerprint changed before activation";
  }
  return record.tool && record.tool !== input.tool ? "resumable MCP tool changed before activation" : undefined;
}
