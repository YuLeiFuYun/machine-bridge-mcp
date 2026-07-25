import {
  DAEMON_HELLO_TIMEOUT_MS,
  daemonLivenessDeadlineMs,
  daemonReadyDeadlineMs,
} from "./daemon-liveness.ts";
import type { DaemonSocketRegistry } from "./daemon-sockets.ts";
import type { PendingCallRegistry } from "./pending-calls.ts";
import { closeWebSocketQuietly, sendWebSocketQuietly } from "./websocket-protocol.ts";

interface AlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

type InvalidateDaemonSocket = (
  socket: WebSocket,
  message: string,
  closeReason: string,
  errorCode?: string,
) => Promise<void>;

interface RuntimeAlarmContext {
  storage: AlarmStorage;
  pending: PendingCallRegistry;
  daemonRegistry: DaemonSocketRegistry;
  invalidateDaemonSocket: InvalidateDaemonSocket;
  onScheduleError: (error: unknown) => void;
}

export async function processRuntimeAlarm(context: RuntimeAlarmContext, now = Date.now()): Promise<void> {
  await context.pending.expireDue();
  let nextDeadline = pendingAlarmDeadline(context.pending, now);
  for (const socket of context.daemonRegistry.candidateSockets()) {
    const attachment = context.daemonRegistry.attachment(socket);
    const connectedAt = Date.parse(attachment?.connectedAt ?? "");
    const deadline = connectedAt + DAEMON_HELLO_TIMEOUT_MS;
    if (!Number.isFinite(connectedAt) || deadline <= now) {
      context.daemonRegistry.expire(socket);
      sendWebSocketQuietly(socket, { type: "error", error: "daemon_hello_timeout" });
      closeWebSocketQuietly(socket, 1008, "daemon hello timeout");
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
  await writeRuntimeAlarm(context, nextDeadline, now);
}

export async function scheduleRuntimeAlarm(context: RuntimeAlarmContext, now = Date.now()): Promise<void> {
  let nextDeadline = pendingAlarmDeadline(context.pending, now);
  for (const socket of context.daemonRegistry.candidateSockets()) {
    const connectedAt = Date.parse(context.daemonRegistry.attachment(socket)?.connectedAt ?? "");
    if (!Number.isFinite(connectedAt)) {
      closeWebSocketQuietly(socket, 1008, "invalid daemon candidate timestamp");
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
  await writeRuntimeAlarm(context, nextDeadline, now);
}

function pendingAlarmDeadline(pending: PendingCallRegistry, now: number): number {
  const delay = pending.nextDeadlineDelayMs();
  return Number.isFinite(delay) ? now + Math.max(1, Math.ceil(delay)) : Number.POSITIVE_INFINITY;
}

async function writeRuntimeAlarm(context: RuntimeAlarmContext, nextDeadline: number, now: number): Promise<void> {
  try {
    if (Number.isFinite(nextDeadline)) await context.storage.setAlarm(Math.max(now, nextDeadline));
    else await context.storage.deleteAlarm();
  } catch (error) {
    context.onScheduleError(error);
  }
}
