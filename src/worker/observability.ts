import { sanitizePortableLogText } from "../shared/log-redaction.mjs";

const MAX_ERROR_CODES = 64;
const MAX_TOOLS = 128;
const SENSITIVE_FIELD = /(?:authorization|cookie|credential|password|secret|token|verifier|private[_-]?key)/i;

export type DaemonTerminalResultDisposition =
  | "transient_committed"
  | "durable_committed"
  | "owner_missing_acknowledged"
  | "stale_connection_rejected";

export type DurableTerminalResultSettlement = "committed" | "missing" | "stale";
export type StreamStorageMutation = "put" | "delete" | "legacy_index_migration";
type StreamMutationListener = (mutation: StreamStorageMutation, rows: number) => void;
type StreamStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list" | "transaction">;
const STREAM_KEY_PREFIX = "mcp-stream:";
const LEGACY_STREAM_INDEX_KEY = "mcp-stream-index";

export function daemonTerminalResultDecision(
  transientMatched: boolean,
  durableSettlement?: DurableTerminalResultSettlement,
): { matched: boolean; acknowledge: boolean; disposition: DaemonTerminalResultDisposition } {
  if (transientMatched) {
    return { matched: true, acknowledge: true, disposition: "transient_committed" };
  }
  if (durableSettlement === "committed") {
    return { matched: true, acknowledge: true, disposition: "durable_committed" };
  }
  if (durableSettlement === "missing") {
    return { matched: false, acknowledge: true, disposition: "owner_missing_acknowledged" };
  }
  return { matched: false, acknowledge: false, disposition: "stale_connection_rejected" };
}

export class WorkerObservability {
  private readonly startedAt = performance.now();
  private readonly requests = { total: 0, successful: 0, client_error: 0, server_error: 0 };
  private readonly calls = { started: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, unmatched_results: 0 };
  private readonly terminalResults = {
    transient_committed: 0, durable_committed: 0,
    owner_missing_acknowledged: 0, stale_connection_rejected: 0,
  };
  private readonly sockets = { candidates: 0, authenticated: 0, ready: 0, disconnected: 0, protocol_errors: 0 };
  private readonly streamTransport = {
    subscribers_opened: 0, subscribers_coexisting: 0, subscriber_limit_rejections: 0,
    legacy_internal_terminal_publications: 0, legacy_internal_live_subscriber_sends: 0,
    legacy_internal_publications_without_live_subscriber: 0, legacy_internal_storage_responses: 0,
    legacy_internal_storage_race_sends: 0, legacy_internal_storage_race_send_failures: 0,
    protocol_errors: 0,
  };
  private readonly oauthRefresh = { rotated: 0, retry_issued: 0, retry_exhausted: 0, family_revoked: 0, rejected: 0 };
  private readonly durableBudget = {
    stream_rows_written_estimate: 0, stream_puts: 0, stream_deletes: 0,
    legacy_index_migrations: 0, alarm_sets: 0, alarm_deletes: 0, alarm_noops: 0,
  };
  private readonly errors = new Map<string, number>();
  private readonly tools = new Map<string, { started: number; completed: number; failed: number; active: number }>();

  requestFinished(status: number): void {
    this.requests.total += 1;
    if (status >= 500) this.requests.server_error += 1;
    else if (status >= 400) this.requests.client_error += 1;
    else this.requests.successful += 1;
  }

  callStarted(tool: string): void {
    this.calls.started += 1;
    const metric = this.toolMetric(tool);
    metric.started += 1;
    metric.active += 1;
  }

  callFinished(tool: string, code = ""): void {
    const metric = this.toolMetric(tool);
    metric.active = Math.max(0, metric.active - 1);
    if (!code) {
      this.calls.completed += 1;
      metric.completed += 1;
      return;
    }
    this.calls.failed += 1;
    metric.failed += 1;
    if (code === "cancelled") this.calls.cancelled += 1;
    if (code === "timeout") this.calls.timed_out += 1;
    this.incrementError(code);
  }

  daemonTerminalResult(disposition: DaemonTerminalResultDisposition): void {
    this.terminalResults[disposition] += 1;
    if (disposition === "owner_missing_acknowledged" || disposition === "stale_connection_rejected") {
      this.calls.unmatched_results += 1;
    }
  }
  recordError(code: string): void { this.incrementError(code); }

  socketCandidate(): void { this.sockets.candidates += 1; }
  socketAuthenticated(): void { this.sockets.authenticated += 1; }
  socketReady(): void { this.sockets.ready += 1; }
  socketDisconnected(): void { this.sockets.disconnected += 1; }
  socketProtocolError(code: string): void {
    this.sockets.protocol_errors += 1;
    this.incrementError(code || "protocol_error");
  }

  streamSubscriberOpened(existing: number): void {
    this.streamTransport.subscribers_opened += 1;
    this.streamTransport.subscribers_coexisting += Math.max(0, Math.floor(existing));
  }

  streamSubscriberRejected(): void {
    this.streamTransport.subscriber_limit_rejections += 1;
    this.incrementError("stream_subscriber_limit");
  }

  streamTerminalPublished(recipients: number): void {
    const delivered = Math.max(0, Math.floor(recipients));
    this.streamTransport.legacy_internal_terminal_publications += 1;
    this.streamTransport.legacy_internal_live_subscriber_sends += delivered;
    if (delivered === 0) this.streamTransport.legacy_internal_publications_without_live_subscriber += 1;
  }

  streamTerminalStorageResponse(): void {
    this.streamTransport.legacy_internal_storage_responses += 1;
  }

  streamTerminalStorageRaceDelivery(delivered: boolean): void {
    if (delivered) this.streamTransport.legacy_internal_storage_race_sends += 1;
    else this.streamTransport.legacy_internal_storage_race_send_failures += 1;
  }

  streamSubscriberProtocolError(): void {
    this.streamTransport.protocol_errors += 1;
    this.incrementError("stream_subscriber_protocol_error");
  }

  oauthRefreshEvent(event: "rotated" | "retry_issued" | "retry_exhausted" | "family_revoked" | "rejected"): void {
    this.oauthRefresh[event] += 1;
  }

  streamStorageRowsWritten(rows: number): void {
    this.durableBudget.stream_rows_written_estimate += Math.max(0, Math.floor(rows));
  }

  streamStorageMutation(mutation: StreamStorageMutation, rows = 1): void {
    const count = Math.max(0, Math.floor(rows));
    this.durableBudget.stream_rows_written_estimate += count;
    if (mutation === "put") this.durableBudget.stream_puts += count;
    else if (mutation === "delete") this.durableBudget.stream_deletes += count;
    else this.durableBudget.legacy_index_migrations += count;
  }

  runtimeAlarmMutation(action: "set" | "delete" | "noop"): void {
    if (action === "set") this.durableBudget.alarm_sets += 1;
    else if (action === "delete") this.durableBudget.alarm_deletes += 1;
    else this.durableBudget.alarm_noops += 1;
  }

  snapshot(): Record<string, unknown> {
    return {
      uptime_ms: Math.max(0, performance.now() - this.startedAt),
      metric_scope: {
        lifecycle: "current_worker_isolate",
        durable_calls_may_cross_isolates: true,
        counters_may_not_balance: true,
        unmatched_results_is_legacy_aggregate: true,
      },
      requests: { ...this.requests },
      calls: { ...this.calls },
      terminal_results: { ...this.terminalResults },
      sockets: { ...this.sockets },
      stream_transport: { ...this.streamTransport },
      oauth_refresh: { ...this.oauthRefresh },
      durable_budget: { ...this.durableBudget },
      errors: Object.fromEntries([...this.errors.entries()].sort(([left], [right]) => left.localeCompare(right))),
      tools: Object.fromEntries([...this.tools.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, metric]) => [name, { ...metric }])),
    };
  }

  event(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
    const entry = {
      ...sanitizeFields(fields),
      timestamp: new Date().toISOString(),
      level,
      component: "worker",
      event: sanitizeName(event),
    };
    const text = JSON.stringify(entry);
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  }

  private toolMetric(tool: string): { started: number; completed: number; failed: number; active: number } {
    const name = sanitizeName(tool) || "unknown";
    if (!this.tools.has(name)) {
      if (this.tools.size >= MAX_TOOLS) return this.toolMetric("other");
      this.tools.set(name, { started: 0, completed: 0, failed: 0, active: 0 });
    }
    return this.tools.get(name)!;
  }

  private incrementError(code: string): void {
    const key = sanitizeName(code) || "execution_failed";
    if (!this.errors.has(key) && this.errors.size >= MAX_ERROR_CODES) {
      this.errors.set("other", (this.errors.get("other") ?? 0) + 1);
      return;
    }
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
  }
}

function sanitizeName(value: unknown): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 128);
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields).slice(0, 32)) {
    const safeKey = sanitizeName(key);
    if (!safeKey) continue;
    if (SENSITIVE_FIELD.test(safeKey)) {
      out[safeKey] = "<redacted>";
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number" || value === null) out[safeKey] = value;
    else if (typeof value === "string") out[safeKey] = sanitizePortableLogText(value, { maxChars: 256 });
  }
  return out;
}


export function meteredMcpStreamStorage(
  storage: DurableObjectStorage,
  onMutation: StreamMutationListener,
): StreamStorage {
  const report = (key: string, operation: "put" | "delete", rows = 1) => {
    if (key.startsWith(STREAM_KEY_PREFIX)) onMutation(operation, rows);
    else if (operation === "delete" && key === LEGACY_STREAM_INDEX_KEY) onMutation("legacy_index_migration", rows);
  };
  const wrapTransaction = (transaction: DurableObjectTransaction, pending: Array<[StreamStorageMutation, number]>) => ({
    get: transaction.get.bind(transaction),
    list: transaction.list.bind(transaction),
    put: async (key: string, value: unknown, options?: DurableObjectPutOptions) => {
      await transaction.put(key, value, options);
      if (key.startsWith(STREAM_KEY_PREFIX)) pending.push(["put", 1]);
    },
    delete: async (key: string, options?: DurableObjectPutOptions) => {
      const removed = await transaction.delete(key, options);
      if (removed) {
        if (key.startsWith(STREAM_KEY_PREFIX)) pending.push(["delete", 1]);
        else if (key === LEGACY_STREAM_INDEX_KEY) pending.push(["legacy_index_migration", 1]);
      }
      return removed;
    },
  }) as unknown as DurableObjectTransaction;
  return {
    get: storage.get.bind(storage),
    list: storage.list.bind(storage),
    put: async (key: string, value: unknown, options?: DurableObjectPutOptions) => {
      await storage.put(key, value, options);
      report(key, "put");
    },
    delete: async (key: string, options?: DurableObjectPutOptions) => {
      const removed = await storage.delete(key, options);
      if (removed) report(key, "delete");
      return removed;
    },
    transaction: async <T>(closure: (transaction: DurableObjectTransaction) => Promise<T>) => {
      const outcome = await storage.transaction(async (transaction) => {
        const pending: Array<[StreamStorageMutation, number]> = [];
        return { value: await closure(wrapTransaction(transaction, pending)), pending };
      });
      for (const [mutation, rows] of outcome.pending) onMutation(mutation, rows);
      return outcome.value;
    },
  } as unknown as StreamStorage;
}
