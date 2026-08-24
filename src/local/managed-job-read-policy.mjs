// @ts-check

import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { clampInteger } from "./numbers.mjs";

const LOCAL_MAXIMUM_WAIT_MS = 40_000;

export function managedJobReadWaitMs(args = {}, context = {}) {
  const hosted = context?.authority?.origin === "relay";
  const fallback = hosted ? relayContract.defaultManagedJobReadWaitMs : 0;
  const maximum = hosted ? relayContract.maximumManagedJobReadWaitMs : LOCAL_MAXIMUM_WAIT_MS;
  return args.wait_ms === undefined ? fallback : clampInteger(args.wait_ms, fallback, 0, maximum);
}

export function managedJobReadNonterminalProgressMinimumMs(args = {}, context = {}) {
  const waitMs = managedJobReadWaitMs(args, context);
  if (context?.authority?.origin !== "relay" || waitMs <= 0) return 0;
  return Math.min(waitMs, relayContract.managedJobReadNonterminalProgressMinimumMs);
}

export function managedJobReadProgressSignature(value, context = {}) {
  const currentStep = context?.authority?.origin === "relay" ? null : value?.current_step;
  return JSON.stringify([
    value?.status, value?.current_phase, currentStep, value?.finished_at,
    value?.error_class, value?.recovery_attempts, value?.result_persisted,
    value?.terminal_record_error_class, value?.artifact_cleanup_pending, value?.artifact_cleanup_error_class,
    value?.dependency_total, value?.dependency_pending_count,
  ]);
}

export function withHostedManagedJobReadMetadata(value, context, waitedMs, timedOut, progressMinimumMs) {
  if (context?.authority?.origin !== "relay") return value;
  return {
    ...value,
    managed_job_read_wait_ms: waitedMs,
    managed_job_read_wait_timed_out: timedOut,
    managed_job_read_nonterminal_progress_minimum_ms: progressMinimumMs,
  };
}
