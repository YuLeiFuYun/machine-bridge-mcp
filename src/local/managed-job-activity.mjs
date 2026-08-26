import { isTerminalManagedJobStatus } from "./managed-job-terminal.mjs";

const WINDOWS_MS = Object.freeze({ one: 60_000, five: 5 * 60_000, fifteen: 15 * 60_000, sixty: 60 * 60_000 });

export function managedJobRecentActivity(records = [], nowMs = Date.now()) {
  const created = records.filter((record) => Number.isFinite(createdAtMs(record)));
  const recent = (windowMs) => created.filter((record) => Math.max(0, nowMs - createdAtMs(record)) <= windowMs);
  const last15 = recent(WINDOWS_MS.fifteen);
  const minuteCounts = new Map();
  for (const record of last15) {
    const bucket = Math.floor(Math.max(0, nowMs - createdAtMs(record)) / 60_000);
    minuteCounts.set(bucket, (minuteCounts.get(bucket) || 0) + 1);
  }
  return {
    created_last_1m: recent(WINDOWS_MS.one).length,
    created_last_5m: recent(WINDOWS_MS.five).length,
    created_last_15m: last15.length,
    created_last_60m: recent(WINDOWS_MS.sixty).length,
    transient_process_last_15m: last15.filter((record) => record.retentionClass === "transient_process").length,
    terminal_last_15m: last15.filter((record) => isTerminalManagedJobStatus(record.job?.status)).length,
    failed_last_15m: last15.filter((record) => failedLike(record.job?.status)).length,
    peak_created_per_minute_last_15m: Math.max(0, ...minuteCounts.values()),
  };
}

function createdAtMs(record) { return Date.parse(String(record?.job?.created_at || "")); }
function failedLike(status) { return /failed|error|exhausted/.test(String(status || "")); }
