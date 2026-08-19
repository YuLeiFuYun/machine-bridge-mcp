import relayContract from "../shared/relay-contract.json" with { type: "json" };

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
    return { remote: true, waitMs: 0, waitForExit, blocking: false, pollThrottled: true };
  }
  return { remote: true, waitMs, waitForExit, blocking: true, pollThrottled: false };
}

export function finishRemoteProcessRead(plan, session, now) {
  if (plan.blocking && session.closedAt === null) session.lastRemoteBlockingReadAt = now;
  if (!plan.remote) return {};
  const nextBlockingPollAfterMs = session.closedAt === null && Number.isFinite(session.lastRemoteBlockingReadAt)
    ? Math.max(0, Math.ceil(relayContract.remoteProcessBlockingPollCooldownMs - Math.max(0, now - session.lastRemoteBlockingReadAt)))
    : 0;
  return {
    blocking_poll_throttled: plan.pollThrottled,
    host_turn_handoff_recommended: session.closedAt === null,
    status_polling_mode: "checkpoint",
    next_blocking_poll_after_ms: nextBlockingPollAfterMs,
  };
}
