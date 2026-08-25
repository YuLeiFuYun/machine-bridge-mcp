// @ts-check

import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";
import {
  managedJobReadNonterminalProgressMinimumMs, managedJobReadProgressSignature, managedJobReadWaitMs,
  withHostedManagedJobReadMetadata,
} from "./managed-job-read-policy.mjs";

export { managedJobReadNonterminalProgressMinimumMs, managedJobReadWaitMs } from "./managed-job-read-policy.mjs";

export async function waitForManagedJobRead({
  args = {}, context = {}, readCurrent, readProgress = readCurrent, throwIfCancelled = () => {},
  sleep = defaultSleep, now = undefined,
}) {
  throwIfCancelled();
  const waitMs = managedJobReadWaitMs(args, context);
  const nonterminalProgressMinimumMs = managedJobReadNonterminalProgressMinimumMs(args, context);
  const progressSignature = (value) => managedJobReadProgressSignature(value, context);
  if (waitMs <= 0) {
    const current = await readCurrent();
    return withHostedManagedJobReadMetadata(current, context, 0, false, nonterminalProgressMinimumMs);
  }
  const deadline = createMonotonicDeadline(waitMs, now);
  let current = await readCurrent();
  const initialSignature = progressSignature(current);
  if (!ACTIVE_JOB_STATES.has(String(current?.status || ""))) {
    return withHostedManagedJobReadMetadata(current, context, 0, false, nonterminalProgressMinimumMs);
  }
  let lastReconcileElapsedMs = deadline.elapsedMs();
  let progressChanged = false;
  while (ACTIVE_JOB_STATES.has(String(current?.status || "")) && !deadline.expired()) {
    throwIfCancelled();
    await sleep(Math.min(relayContract.managedJobReadPollIntervalMs, Math.max(1, deadline.remainingMs())));
    throwIfCancelled();
    const progress = await readProgress();
    if (!ACTIVE_JOB_STATES.has(String(progress?.status || ""))) {
      current = await readCurrent();
      break;
    }
    progressChanged = progressSignature(progress) !== initialSignature;
    current = { ...current, ...progress };
    const elapsed = deadline.elapsedMs();
    if (progressChanged && elapsed >= nonterminalProgressMinimumMs) {
      current = await readCurrent();
      break;
    }
    if (elapsed - lastReconcileElapsedMs >= relayContract.managedJobReadReconcileIntervalMs) {
      current = await readCurrent();
      lastReconcileElapsedMs = deadline.elapsedMs();
      if (!ACTIVE_JOB_STATES.has(String(current?.status || ""))) break;
      progressChanged = progressSignature(current) !== initialSignature;
      if (progressChanged && lastReconcileElapsedMs >= nonterminalProgressMinimumMs) break;
    }
  }
  const timedOut = ACTIVE_JOB_STATES.has(String(current?.status || ""))
    && !progressChanged && progressSignature(current) === initialSignature && deadline.expired();
  return withHostedManagedJobReadMetadata(current, context, Math.min(waitMs, Math.round(deadline.elapsedMs())), timedOut,
    nonterminalProgressMinimumMs);
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
