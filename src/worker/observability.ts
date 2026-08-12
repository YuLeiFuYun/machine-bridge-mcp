import { sanitizePortableLogText } from "../shared/log-redaction.mjs";

const MAX_ERROR_CODES = 64;
const MAX_TOOLS = 128;
const SENSITIVE_FIELD = /(?:authorization|cookie|credential|password|secret|token|verifier|private[_-]?key)/i;

export type DaemonTerminalResultDisposition =
  | "committed"
  | "owner_missing_acknowledged"
  | "stale_connection_rejected";

export class WorkerObservability {
  private readonly startedAt = performance.now();
  private readonly requests = { total: 0, successful: 0, client_error: 0, server_error: 0 };
  private readonly calls = { started: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
  private readonly terminalResults = {
    committed: 0, owner_missing_acknowledged: 0, stale_connection_rejected: 0,
  };
  private readonly sockets = { candidates: 0, authenticated: 0, ready: 0, disconnected: 0, protocol_errors: 0 };
  private readonly oauthRefresh = { rotated: 0, retry_issued: 0, retry_exhausted: 0, family_revoked: 0, rejected: 0 };
  private readonly runtimeAlarm = { sets: 0, deletes: 0, noops: 0 };
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

  oauthRefreshEvent(event: "rotated" | "retry_issued" | "retry_exhausted" | "family_revoked" | "rejected"): void {
    this.oauthRefresh[event] += 1;
  }

  runtimeAlarmMutation(action: "set" | "delete" | "noop"): void {
    if (action === "set") this.runtimeAlarm.sets += 1;
    else if (action === "delete") this.runtimeAlarm.deletes += 1;
    else this.runtimeAlarm.noops += 1;
  }

  snapshot(): Record<string, unknown> {
    return {
      uptime_ms: Math.max(0, performance.now() - this.startedAt),
      metric_scope: {
        lifecycle: "current_worker_isolate",
        request_scoped_calls: true,
        counters_may_not_balance_across_isolate_restarts: true,
      },
      requests: { ...this.requests },
      calls: { ...this.calls },
      terminal_results: { ...this.terminalResults },
      sockets: { ...this.sockets },
      oauth_refresh: { ...this.oauthRefresh },
      runtime_alarm: { ...this.runtimeAlarm },
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
  const out = Object.create(null) as Record<string, unknown>;
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
