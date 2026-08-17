import type { PendingCallRecord } from "./pending-call-contract.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
export type PendingCallDeadlineOptions = {
  now?: () => number;
  scheduler?: {
    setTimeout: (callback: () => void, delay: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle) => void;
  };
};

export class PendingCallDeadlines {
  private readonly clock: () => number;
  private readonly scheduler: Required<PendingCallDeadlineOptions>["scheduler"];

  constructor(options: PendingCallDeadlineOptions = {}) {
    this.clock = options.now ?? (() => performance.now());
    this.scheduler = options.scheduler ?? { setTimeout, clearTimeout };
  }

  now(): number {
    return this.clock();
  }

  nextDelayMs(record: PendingCallRecord): number {
    const deadline = record.socket ? record.deadlineAt : record.reconnectDeadlineAt;
    return Number.isFinite(deadline) ? Math.max(0, Number(deadline) - this.clock()) : Number.POSITIVE_INFINITY;
  }

  isDue(record: PendingCallRecord, now = this.clock()): boolean {
    const deadline = record.socket ? record.deadlineAt : record.reconnectDeadlineAt;
    return Number.isFinite(deadline) && Number(deadline) <= now;
  }

  armOperation(record: PendingCallRecord, delayMs: number, expire: (id: string) => void): void {
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    const delay = boundedPendingDelayMs(delayMs);
    record.remainingTimeoutMs = delay;
    record.deadlineAt = this.clock() + delay;
    record.timeout = this.scheduler.setTimeout(() => expire(record.id), delay);
  }

  pauseOperation(record: PendingCallRecord): void {
    record.remainingTimeoutMs = Math.max(1, Math.ceil(record.deadlineAt - this.clock()));
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    record.timeout = undefined;
  }

  armReconnect(record: PendingCallRecord, delayMs: number, expire: (id: string) => void): void {
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    const delay = boundedPendingDelayMs(delayMs);
    record.reconnectDeadlineAt = this.clock() + delay;
    record.reconnectTimeout = this.scheduler.setTimeout(() => expire(record.id), delay);
  }

  clearReconnect(record: PendingCallRecord): void {
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    record.reconnectTimeout = undefined;
    record.reconnectDeadlineAt = undefined;
  }

  clear(record: PendingCallRecord): void {
    if (record.timeout) this.scheduler.clearTimeout(record.timeout);
    if (record.reconnectTimeout) this.scheduler.clearTimeout(record.reconnectTimeout);
    record.reconnectDeadlineAt = undefined;
  }
}

export function boundedPendingDelayMs(value: unknown, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("pending-call delay maximum must be a positive safe integer");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`pending-call delay must be an integer from 1 to ${maximum}`);
  }
  return value;
}
