import type { DaemonChannel } from "./daemon-channel.ts";
import { trySendDaemonChannel } from "./daemon-channel.ts";
import { dispatchedDaemonPlannedDrainError } from "./errors.ts";
import type { PendingCallRegistry } from "./pending-calls.ts";
import type { WorkerObservability } from "./observability.ts";
import { recordWorkerPlannedDrain } from "./worker-continuity-evidence.ts";

export async function settleDaemonPlannedDrain(input: {
  channel: DaemonChannel;
  body: Record<string, unknown>;
  pending: PendingCallRegistry;
  storage: DurableObjectStorage;
  observability: WorkerObservability;
  beginDrain: (channel: DaemonChannel) => boolean;
}): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> {
  const drainId = typeof input.body.drain_id === "string" && /^drain_[A-Za-z0-9_-]{24}$/.test(input.body.drain_id)
    ? input.body.drain_id : "";
  if (!drainId) return { ok: false, errorCode: "invalid_daemon_draining", errorMessage: "invalid daemon draining message" };
  if (!input.beginDrain(input.channel)) return { ok: false, errorCode: "invalid_daemon_draining", errorMessage: "daemon channel is not eligible for planned drain" };
  const rejected = await input.pending.rejectSocket(input.channel, (record) => dispatchedDaemonPlannedDrainError(record.recovery));
  input.observability.daemonPlannedDrain(rejected);
  const acknowledged = trySendDaemonChannel(input.channel, { type: "daemon_draining_ack", drain_id: drainId });
  const evidencePersisted = await recordWorkerPlannedDrain(input.storage, rejected);
  input.observability.event(acknowledged ? "info" : "warn", "daemon.planned_drain", {
    pending_calls_settled: rejected, acknowledgement_sent: acknowledged, continuity_evidence_persisted: evidencePersisted,
  });
  return { ok: true };
}
