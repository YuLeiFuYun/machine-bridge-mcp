type EdgeLogLevel = "warn" | "error";
type EdgeLogWriter = (level: EdgeLogLevel, text: string) => void;
const SENSITIVE_FIELD = /(?:authorization|cookie|password|secret|token|key|credential|proof)/i;

export function createThrottledEdgeLogger(options: {
  intervalMs?: number;
  now?: () => number;
  write?: EdgeLogWriter;
} = {}): (level: EdgeLogLevel, event: string, fields?: Record<string, unknown>) => boolean {
  const intervalMs = positiveInterval(options.intervalMs, 60_000);
  const now = options.now ?? Date.now;
  const write = options.write ?? defaultWrite;
  let nextAt = 0;
  let suppressed = 0;
  return (level, event, fields = {}) => {
    const current = now();
    if (current < nextAt) {
      suppressed += 1;
      return false;
    }
    const entry = {
      ...safeFields(fields),
      ...(suppressed > 0 ? { suppressed } : {}),
      timestamp: new Date(current).toISOString(),
      level,
      component: "worker-edge",
      event: safeName(event),
    };
    suppressed = 0;
    nextAt = current + intervalMs;
    write(level, JSON.stringify(entry));
    return true;
  };
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields).slice(0, 16)) {
    const name = safeName(key);
    if (!name) continue;
    if (SENSITIVE_FIELD.test(name)) {
      out[name] = "<redacted>";
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) out[name] = value;
    else if (typeof value === "string") out[name] = value.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160);
  }
  return out;
}

function safeName(value: unknown): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 96);
}

function positiveInterval(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function defaultWrite(level: EdgeLogLevel, text: string): void {
  if (level === "error") console.error(text);
  else console.warn(text);
}
