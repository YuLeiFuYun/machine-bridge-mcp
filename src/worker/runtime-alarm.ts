import {
  DAEMON_HELLO_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  daemonReadyDeadlineMs,
} from "./daemon-liveness.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import type { McpPendingCallStore, PendingStreamCallView } from "./mcp-pending-call-store.ts";
import type { PendingCallRegistry } from "./pending-calls.ts";
import { writeEarliestRuntimeAlarm, type AlarmStorage } from "./runtime-alarm-storage.ts";

type InvalidateDaemonSocket = (
  socket: WebSocket,
  message: string,
  closeReason: string,
  errorCode?: string,
) => Promise<void>;

interface RuntimeAlarmContext {
  storage: AlarmStorage;
  pending: PendingCallRegistry;
  durableCalls?: Pick<McpPendingCallStore, "due" | "nextDeadlineDelayMs">;
  expireDurableCall?: (call: PendingStreamCallView) => Promise<void>;
  daemonRegistry: DaemonSocketRegistry;
  invalidateDaemonSocket: InvalidateDaemonSocket;
  onScheduleError: (error: unknown) => void;
  onAlarmMutation?: (action: "set" | "delete" | "noop") => void;
}

export async function processRuntimeAlarm(context: RuntimeAlarmContext, now = Date.now()): Promise<void> {
  await context.pending.expireDue();
  if (context.durableCalls && context.expireDurableCall) {
    for (const call of await context.durableCalls.due(now)) await context.expireDurableCall(call);
  }
  let nextDeadline = Number.POSITIVE_INFINITY;
  for (const socket of context.daemonRegistry.candidateSockets()) {
    const attachment = context.daemonRegistry.attachment(socket);
    const connectedAt = Date.parse(attachment?.connectedAt ?? "");
    const deadline = connectedAt + DAEMON_HELLO_TIMEOUT_MS;
    if (!Number.isFinite(connectedAt) || deadline <= now) {
      await context.invalidateDaemonSocket(
        socket,
        "daemon did not complete authentication",
        "daemon hello timeout",
        "daemon_hello_timeout",
      );
      continue;
    }
    nextDeadline = Math.min(nextDeadline, deadline);
  }
  for (const socket of context.daemonRegistry.probingSockets()) {
    const attachment = context.daemonRegistry.attachment(socket);
    const readyDeadline = daemonReadyDeadlineMs(attachment);
    const liveDeadline = daemonLivenessDeadlineMs(attachment);
    if (!Number.isFinite(readyDeadline) || !Number.isFinite(liveDeadline) || Math.min(readyDeadline, liveDeadline) <= now) {
      await context.invalidateDaemonSocket(
        socket,
        "daemon did not complete end-to-end readiness verification",
        "daemon ready timeout",
        "daemon_ready_timeout",
      );
      continue;
    }
    nextDeadline = Math.min(nextDeadline, readyDeadline, liveDeadline);
  }
  for (const socket of context.daemonRegistry.readyRoleSockets()) {
    const deadline = daemonLivenessDeadlineMs(context.daemonRegistry.readyAttachment(socket));
    if (!Number.isFinite(deadline) || deadline <= now) {
      await context.invalidateDaemonSocket(socket, "daemon became unresponsive", "daemon liveness timeout");
      continue;
    }
    nextDeadline = Math.min(nextDeadline, deadline);
  }
  nextDeadline = Math.min(nextDeadline, await pendingAlarmDeadline(context, now));
  await writeEarliestRuntimeAlarm({
    storage: context.storage,
    nextDeadline,
    now,
    onError: context.onScheduleError,
    onMutation: context.onAlarmMutation,
  });
}

export async function scheduleRuntimeAlarm(context: RuntimeAlarmContext, now = Date.now()): Promise<void> {
  let nextDeadline = Number.POSITIVE_INFINITY;
  for (const socket of context.daemonRegistry.candidateSockets()) {
    const connectedAt = Date.parse(context.daemonRegistry.attachment(socket)?.connectedAt ?? "");
    if (!Number.isFinite(connectedAt)) {
      await context.invalidateDaemonSocket(
        socket,
        "daemon candidate timestamp is invalid",
        "invalid daemon candidate timestamp",
        "daemon_hello_timeout",
      );
      continue;
    }
    nextDeadline = Math.min(nextDeadline, connectedAt + DAEMON_HELLO_TIMEOUT_MS);
  }
  for (const socket of context.daemonRegistry.probingSockets()) {
    const attachment = context.daemonRegistry.attachment(socket);
    const readyDeadline = daemonReadyDeadlineMs(attachment);
    const liveDeadline = daemonLivenessDeadlineMs(attachment);
    if (!Number.isFinite(readyDeadline) || !Number.isFinite(liveDeadline)) {
      await context.invalidateDaemonSocket(
        socket,
        "daemon readiness state is invalid",
        "daemon ready timeout",
        "daemon_ready_timeout",
      );
      continue;
    }
    nextDeadline = Math.min(nextDeadline, readyDeadline, liveDeadline);
  }
  for (const socket of context.daemonRegistry.readyRoleSockets()) {
    const deadline = daemonLivenessDeadlineMs(context.daemonRegistry.readyAttachment(socket));
    if (!Number.isFinite(deadline)) {
      await context.invalidateDaemonSocket(socket, "daemon became unresponsive", "invalid daemon liveness timestamp");
      continue;
    }
    nextDeadline = Math.min(nextDeadline, deadline);
  }
  nextDeadline = Math.min(nextDeadline, await pendingAlarmDeadline(context, now));
  await writeEarliestRuntimeAlarm({
    storage: context.storage,
    nextDeadline,
    now,
    onError: context.onScheduleError,
    onMutation: context.onAlarmMutation,
  });
}

async function pendingAlarmDeadline(context: RuntimeAlarmContext, now: number): Promise<number> {
  const transientDelay = context.pending.nextDeadlineDelayMs();
  const durableDelay = context.durableCalls
    ? await context.durableCalls.nextDeadlineDelayMs()
    : Number.POSITIVE_INFINITY;
  const delay = Math.min(transientDelay, durableDelay);
  return Number.isFinite(delay) ? now + Math.max(1, Math.ceil(delay)) : Number.POSITIVE_INFINITY;
}
