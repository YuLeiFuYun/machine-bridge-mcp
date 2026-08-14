import { BridgeError } from "./errors.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { notifySessionWaiters, waitForSessionChange } from "./process-session-events.mjs";

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
