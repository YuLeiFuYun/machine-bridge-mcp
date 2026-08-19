const CONNECT_STAGES = new Set([
  "socket_constructing", "proxy_connecting", "tcp_connecting", "dns_resolved",
  "tcp_connected", "tls_established", "http_rejected", "websocket_open",
]);

export class RelayConnectTiming {
  constructor(now) {
    this.now = now;
    this.startedAt = null;
    this.durationMs = 0;
    this.stage = "idle";
    this.httpStatus = null;
    this.milestones = {};
    this.lastFailure = null;
  }

  begin() {
    this.startedAt = this.now();
    this.stage = "socket_constructing";
    this.httpStatus = null;
    this.milestones = { socket_constructing: 0 };
  }

  observe(stage) {
    if (!Number.isFinite(this.startedAt)) return;
    const name = String(stage || "");
    if (!CONNECT_STAGES.has(name)) return;
    this.stage = name;
    this.milestones[name] = this.elapsed();
  }

  rejectHttp(status) {
    this.observe("http_rejected");
    this.httpStatus = Number.isInteger(status) ? status : null;
  }

  finish() {
    if (!Number.isFinite(this.startedAt)) return;
    this.durationMs = this.elapsed();
    this.startedAt = null;
  }

  captureFailure() {
    this.finish();
    this.lastFailure = {
      stage: this.stage, durationMs: Math.max(0, Math.round(this.durationMs)),
      milestones: { ...this.milestones }, httpStatus: this.httpStatus,
    };
  }

  elapsed() { return Math.max(0, Math.round(this.now() - this.startedAt)); }

  snapshot() {
    const failed = this.lastFailure;
    return {
      last_connect_stage: this.stage,
      last_connect_duration_ms: Number.isFinite(this.startedAt) ? this.elapsed() : Math.max(0, Math.round(this.durationMs)),
      last_connect_milestones_ms: { ...this.milestones },
      last_connect_http_status: this.httpStatus,
      last_failed_connect_stage: failed?.stage ?? null,
      last_failed_connect_duration_ms: failed?.durationMs ?? 0,
      last_failed_connect_milestones_ms: failed ? { ...failed.milestones } : {},
      last_failed_connect_http_status: failed?.httpStatus ?? null,
    };
  }
}
