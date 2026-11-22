import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { createMonotonicDeadline } from "../core/timing.mjs";
import { clampInteger } from "../../shared/numbers.mjs";
import { BridgeError } from "../core/errors.mjs";

export function waitForSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => { cleanup(); resolvePromise(); };
    const onError = (error) => { cleanup(); rejectPromise(error); };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function sessionHasOutputAfter(session, stdoutOffset, stderrOffset) {
  return session.stdout.totalBytes > stdoutOffset || session.stderr.totalBytes > stderrOffset;
}

export function notifySessionWaiters(session) {
  for (const waiter of [...session.waiters]) waiter();
}

export function waitForSessionChange(session, waitMs, cancellationCheck, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const done = () => {
      cleanup();
      try {
        cancellationCheck();
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      session.waiters.delete(done);
    };
    session.waiters.add(done);
    timer = setTimeout(done, waitMs);
    if (options.keepAlive !== true) timer.unref?.();
  });
}
export function planRemoteProcessRead({ context, session, requestedWaitMs, waitForExit, hasOutput, now }) {
  const remote = context?.authority?.origin === "relay";
  const waitMs = remote ? Math.min(requestedWaitMs, relayContract.maximumProcessReadWaitMs) : requestedWaitMs;
  const wouldBlock = waitMs > 0 && session.closedAt === null && (waitForExit || !hasOutput);
  if (!remote || !wouldBlock) return { remote, waitMs, waitForExit, blocking: false, pollThrottled: false };

  const lastBlockingReadAt = Number.isFinite(session.lastRemoteBlockingReadAt)
    ? session.lastRemoteBlockingReadAt
    : null;
  const elapsed = lastBlockingReadAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - lastBlockingReadAt);
  if (elapsed < relayContract.remoteProcessBlockingPollCooldownMs) {
    return {
      remote: true, waitMs, waitForExit, blocking: false, pollThrottled: true,
      cooldownWaitMs: Math.max(1, Math.ceil(relayContract.remoteProcessBlockingPollCooldownMs - elapsed)),
    };
  }
  return { remote: true, waitMs, waitForExit, blocking: true, pollThrottled: false, cooldownWaitMs: 0 };
}

export function finishRemoteProcessRead(plan, session, now) {
  if (plan.blocking && session.closedAt === null) session.lastRemoteBlockingReadAt = now;
  if (!plan.remote) return {};
  const nextBlockingPollAfterMs = session.closedAt === null && Number.isFinite(session.lastRemoteBlockingReadAt)
    ? Math.max(0, Math.ceil(relayContract.remoteProcessBlockingPollCooldownMs - Math.max(0, now - session.lastRemoteBlockingReadAt)))
    : 0;
  return {
    blocking_poll_throttled: plan.pollThrottled,
    host_turn_handoff_recommended: false,
    status_polling_mode: session.closedAt === null ? "paced_followup" : "terminal",
    tool_schema_generation: Number(serverMetadata.toolSchemaGeneration),
    host_turn_deadline_observable: false,
    next_blocking_poll_after_ms: nextBlockingPollAfterMs,
  };
}
export async function readProcessSession({ args, context, session, throwIfCancelled, now }) {
  const stdoutOffset = clampInteger(args.stdout_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const stderrOffset = clampInteger(args.stderr_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const hosted = context?.authority?.origin === "relay";
  const hostedMaximum = Number(relayContract.maximumHostedProcessReadBytes);
  const maxBytes = clampInteger(args.max_bytes, hosted ? hostedMaximum : 64 * 1024, 1, hosted ? hostedMaximum : 256 * 1024);
  const remoteRead = planRemoteProcessRead({
    context,
    session,
    requestedWaitMs: clampInteger(
      args.wait_ms,
      context?.authority?.origin === "relay" ? relayContract.maximumProcessReadWaitMs : 0,
      0,
      30_000,
    ),
    waitForExit: args.wait_for_exit === true,
    hasOutput: sessionHasOutputAfter(session, stdoutOffset, stderrOffset),
    now: now(),
  });
  throwIfCancelled(context);
  if (remoteRead.cooldownWaitMs > 0 && session.closedAt === null
      && (remoteRead.waitForExit || !sessionHasOutputAfter(session, stdoutOffset, stderrOffset))) {
    if (remoteRead.waitForExit) {
      const cooldownDeadline = createMonotonicDeadline(remoteRead.cooldownWaitMs, now);
      while (session.closedAt === null && !cooldownDeadline.expired()) {
        await waitForSessionChange(session, Math.max(1, cooldownDeadline.remainingMs()), () => throwIfCancelled(context));
      }
    } else {
      await waitForSessionChange(session, remoteRead.cooldownWaitMs, () => throwIfCancelled(context));
    }
    throwIfCancelled(context);
  }
  if (remoteRead.waitMs > 0 && session.closedAt === null) {
    const deadline = createMonotonicDeadline(remoteRead.waitMs);
    if (remoteRead.waitForExit) {
      remoteRead.blocking = true;
      while (session.closedAt === null && !deadline.expired()) {
        await waitForSessionChange(session, Math.max(1, deadline.remainingMs()), () => throwIfCancelled(context));
      }
    } else if (!sessionHasOutputAfter(session, stdoutOffset, stderrOffset)) {
      remoteRead.blocking = true;
      await waitForSessionChange(session, remoteRead.waitMs, () => throwIfCancelled(context));
    }
  }
  throwIfCancelled(context);
  return {
    remoteRead,
    stdout: session.stdout.read(stdoutOffset, maxBytes),
    stderr: session.stderr.read(stderrOffset, maxBytes),
  };
}

export function completeProcessSessionRead(read, session, now) {
  const { remoteRead, ...output } = read;
  return {
    ...finishRemoteProcessRead(remoteRead, session, now),
    ...output,
  };
}
export async function terminateProcessSessions({
  sessions,
  matches = () => true,
  terminateTree,
  signal = "SIGKILL",
  waitMs = 5_000,
  mode = "shutdown",
}) {
  const contract = terminationContract(mode);
  let settledCount = 0;
  let failure = null;
  const settlements = [];
  for (const [id, session] of [...sessions.entries()]) {
    if (!matches(session)) continue;
    notifySessionWaiters(session);
    if (session.closedAt !== null) {
      if (sessions.get(id) === session) sessions.delete(id);
      settledCount += 1;
      continue;
    }
    if (!session.child) {
      failure ||= new Error(contract.missingChild);
      continue;
    }
    let requested = false;
    try { requested = terminateTree(session.child, signal) === true; }
    catch { /* The retained session handle makes failed termination delivery retryable. */ }
    if (!requested) {
      failure ||= new Error(contract.requestFailure);
      continue;
    }
    settlements.push(settleProcessSession(sessions, id, session, waitMs).then((settled) => {
      if (settled) settledCount += 1;
      else failure ||= new Error(contract.settlementFailure);
    }));
  }
  await Promise.all(settlements);
  if (failure) {
    throw new BridgeError("unavailable", contract.unavailable, { cause: failure, retryable: true });
  }
  return settledCount;
}

async function settleProcessSession(sessions, id, session, waitMs) {
  const deadline = createMonotonicDeadline(waitMs);
  while (session.closedAt === null && !deadline.expired()) {
    await waitForSessionChange(session, Math.max(1, deadline.remainingMs()), () => {}, { keepAlive: true });
  }
  if (session.closedAt === null) return false;
  if (sessions.get(id) === session) sessions.delete(id);
  return true;
}

function terminationContract(mode) {
  if (mode === "authority_revocation") {
    return {
      missingChild: "process-session termination request could not be delivered",
      requestFailure: "process-session termination request could not be delivered",
      settlementFailure: "process-session termination did not settle before the revocation deadline",
      unavailable: "process-session authority revocation was incomplete; retained revocation must be retried",
    };
  }
  return {
    missingChild: "process-session shutdown has no retained child handle",
    requestFailure: "process-session shutdown request could not be delivered",
    settlementFailure: "process-session shutdown did not settle before the runtime teardown deadline",
    unavailable: "process-session shutdown was incomplete; runtime ownership must be retained",
  };
}
