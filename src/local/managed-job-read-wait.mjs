// @ts-check

import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { clampInteger } from "./numbers.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

const LOCAL_MAXIMUM_WAIT_MS = 40_000;

export function managedJobReadWaitMs(args = {}, context = {}) {
  const remote = context?.authority?.origin === "relay";
  const fallback = remote ? relayContract.defaultManagedJobReadWaitMs : 0;
  const maximum = remote ? relayContract.maximumManagedJobReadWaitMs : LOCAL_MAXIMUM_WAIT_MS;
  return args.wait_ms === undefined ? fallback : clampInteger(args.wait_ms, fallback, 0, maximum);
}

export async function waitForManagedJobRead({
  args = {}, context = {}, readCurrent, readProgress = readCurrent, throwIfCancelled = () => {},
  sleep = defaultSleep, now = undefined,
}) {
  throwIfCancelled();
  let current = await readCurrent();
  const waitMs = managedJobReadWaitMs(args, context);
  const initialSignature = managedJobProgressSignature(current);
  if (!ACTIVE_JOB_STATES.has(String(current?.status || "")) || waitMs <= 0) {
    return withHostedWaitMetadata(current, context, 0, false);
  }
  const deadline = createMonotonicDeadline(waitMs, now);
  let lastReconcileElapsedMs = 0;
  while (ACTIVE_JOB_STATES.has(String(current?.status || "")) && !deadline.expired()) {
    throwIfCancelled();
    await sleep(Math.min(relayContract.managedJobReadPollIntervalMs, Math.max(1, deadline.remainingMs())));
    throwIfCancelled();
    const progress = await readProgress();
    if (managedJobProgressSignature(progress) !== initialSignature) {
      current = await readCurrent();
      break;
    }
    const elapsed = deadline.elapsedMs();
    if (elapsed - lastReconcileElapsedMs >= relayContract.managedJobReadReconcileIntervalMs) {
      current = await readCurrent();
      lastReconcileElapsedMs = elapsed;
      if (managedJobProgressSignature(current) !== initialSignature) break;
    }
  }
  const finalElapsedMs = deadline.elapsedMs();
  if (managedJobProgressSignature(current) === initialSignature && lastReconcileElapsedMs < finalElapsedMs) {
    current = await readCurrent();
  }
  const timedOut = ACTIVE_JOB_STATES.has(String(current?.status || ""))
    && managedJobProgressSignature(current) === initialSignature && deadline.expired();
  return withHostedWaitMetadata(current, context, Math.min(waitMs, Math.round(deadline.elapsedMs())), timedOut);
}

function managedJobProgressSignature(value) {
  return JSON.stringify([
    value?.status, value?.current_phase, value?.current_step, value?.finished_at,
    value?.error_class, value?.recovery_attempts, value?.result_persisted,
    value?.terminal_record_error_class, value?.artifact_cleanup_pending, value?.artifact_cleanup_error_class,
  ]);
}

function withHostedWaitMetadata(value, context, waitedMs, timedOut) {
  if (context?.authority?.origin !== "relay") return value;
  return {
    ...value,
    managed_job_read_wait_ms: waitedMs,
    managed_job_read_wait_timed_out: timedOut,
  };
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
