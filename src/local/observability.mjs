const DURATION_BUCKETS_MS = Object.freeze([100, 1000, 10_000, 30_000, 60_000]);
const MAX_TOOLS = 128;
const MAX_ERROR_CODES = 64;

export class RuntimeObservability {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.startedAt = this.now();
    this.calls = { started: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, slow: 0 };
    this.byTool = new Map();
    this.errors = new Map();
  }

  start(tool) {
    this.calls.started += 1;
    const metric = this.toolMetric(tool);
    metric.started += 1;
    metric.active += 1;
  }

  finish(tool, { status, durationMs, errorCode = "", slow = false } = {}) {
    const metric = this.toolMetric(tool);
    metric.active = Math.max(0, metric.active - 1);
    metric.last_duration_ms = boundedDuration(durationMs);
    metric.max_duration_ms = Math.max(metric.max_duration_ms, metric.last_duration_ms);
    metric.total_duration_ms += metric.last_duration_ms;
    metric.duration_buckets[bucketName(metric.last_duration_ms)] += 1;
    if (status === "completed") { this.calls.completed += 1; metric.completed += 1; }
    else {
      this.calls.failed += 1;
      metric.failed += 1;
      if (status === "cancelled") this.calls.cancelled += 1;
      if (status === "timeout") this.calls.timed_out += 1;
      if (errorCode) this.incrementError(errorCode);
    }
    if (slow) { this.calls.slow += 1; metric.slow += 1; }
  }

  snapshot() {
    return {
      uptime_ms: Math.max(0, this.now() - this.startedAt),
      calls: { ...this.calls },
      active: [...this.byTool.values()].reduce((sum, metric) => sum + metric.active, 0),
      errors: Object.fromEntries([...this.errors.entries()].sort(([a], [b]) => a.localeCompare(b))),
      tools: Object.fromEntries([...this.byTool.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, metric]) => [name, {
        ...metric,
        duration_buckets: { ...metric.duration_buckets },
      }])),
    };
  }

  toolMetric(tool) {
    const name = String(tool || "unknown").slice(0, 128) || "unknown";
    if (!this.byTool.has(name)) {
      if (this.byTool.size >= MAX_TOOLS) return this.toolMetric("<other>");
      this.byTool.set(name, {
        started: 0, completed: 0, failed: 0, active: 0, slow: 0,
        total_duration_ms: 0, max_duration_ms: 0, last_duration_ms: 0,
        duration_buckets: Object.fromEntries([...DURATION_BUCKETS_MS.map((value) => [`le_${value}`, 0]), ["gt_60000", 0]]),
      });
    }
    return this.byTool.get(name);
  }

  incrementError(code) {
    const key = String(code || "execution_failed").slice(0, 64);
    if (!this.errors.has(key) && this.errors.size >= MAX_ERROR_CODES) {
      this.errors.set("<other>", (this.errors.get("<other>") || 0) + 1);
      return;
    }
    this.errors.set(key, (this.errors.get(key) || 0) + 1);
  }
}

function bucketName(durationMs) {
  for (const threshold of DURATION_BUCKETS_MS) if (durationMs <= threshold) return `le_${threshold}`;
  return "gt_60000";
}

function boundedDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
}
