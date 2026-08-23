import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { clampInteger } from "./numbers.mjs";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { finishRemoteProcessRead, planRemoteProcessRead } from "./process-session-remote-poll.mjs";
import { sessionHasOutputAfter, waitForSessionChange } from "./process-session-events.mjs";

export async function readProcessSession({ args, context, session, throwIfCancelled, now }) {
  const stdoutOffset = clampInteger(args.stdout_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const stderrOffset = clampInteger(args.stderr_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = clampInteger(args.max_bytes, 64 * 1024, 1, 256 * 1024);
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
