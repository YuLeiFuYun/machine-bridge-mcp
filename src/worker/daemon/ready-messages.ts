import { acknowledgeAuthorityRevocation, authorityRevocationAckId } from "../oauth/authority-revocations.ts";
import type { DaemonChannel } from "./channel.ts";
import { daemonCallNotReceivedAfterReconnectError, daemonToolError, dispatchedDaemonPlannedDrainError } from "../room/errors.ts";
import type { PendingCallOutcome, PendingCallRegistry } from "../room/pending-calls.ts";
import type { WorkerObservability } from "../room/observability.ts";
import { trySendDaemonChannel } from "./channel.ts";
import { recordWorkerPlannedDrain } from "./continuity-evidence.ts";
import { daemonResumeMissingCallIds } from "../room/websocket-protocol.ts";

export type ReadyMessageDisposition = Readonly<{
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}>;

export async function handleReadyDaemonMessage(input: {
  channel: DaemonChannel;
  body: Record<string, unknown>;
  pending: PendingCallRegistry;
  storage: DurableObjectStorage;
  observability: WorkerObservability;
  beginDrain: (channel: DaemonChannel) => boolean;
}): Promise<ReadyMessageDisposition> {
  const { channel, body, pending, storage, observability, beginDrain } = input;
  if (body.type === "resume_calls_ack") {
    const acknowledgement = daemonResumeAcknowledgement(channel, body.missing_ids);
    if (!acknowledgement) return invalid("invalid_resume_calls_ack", "invalid resume calls acknowledgement");
    if (!acknowledgement.duplicate) await settleDaemonProvenMissingCalls({ ids: acknowledgement.missingIds, channel, pending, observability });
    return { ok: true };
  }
  if (body.type === "authority_revoke_ack") {
    const revocationId = authorityRevocationAckId(body.revocation_id);
    if (!revocationId) return invalid("invalid_authority_revoke_ack", "invalid authority revocation acknowledgement");
    await acknowledgeAuthorityRevocation(storage, revocationId);
    return { ok: true };
  }
  if (body.type === "daemon_draining") return settleDaemonPlannedDrain({ channel, body, pending, storage, observability, beginDrain });
  if (body.type !== "tool_result" || typeof body.id !== "string") {
    return invalid("unknown_message_type", "unknown daemon message type");
  }
  const outcome: PendingCallOutcome = body.ok === false
    ? { ok: false, error: daemonToolError(body.error) }
    : { ok: true, value: body.result };
  const ownership = pending.resultOwnership(body.id, channel);
  const transientMatched = ownership === "owned" && (outcome.ok
    ? await pending.resolve(body.id, channel, outcome.value)
    : await pending.reject(body.id, outcome.error, channel));
  if (transientMatched || ownership === "missing") trySendDaemonChannel(channel, { type: "tool_result_ack", id: body.id });
  observability.daemonTerminalResult(transientMatched ? "committed"
    : ownership === "missing" ? "owner_missing_acknowledged" : "stale_connection_rejected");
  return { ok: true };
}

export async function settleDaemonProvenMissingCalls(input: {
  ids: Iterable<string>;
  channel: DaemonChannel;
  pending: PendingCallRegistry;
  observability: WorkerObservability;
}): Promise<{ redelivered: number; rejected: number }> {
  let redelivered = 0;
  const rejected = await input.pending.rejectSocketIds(
    input.ids, input.channel, (record) => daemonCallNotReceivedAfterReconnectError(record.recovery), undefined,
    (record) => {
      if (record.provenMissingRedeliveryChannel) return record.provenMissingRedeliveryChannel === input.channel;
      if (record.redeliverAfterProvenMissing?.(record, input.channel) !== true) return false;
      record.provenMissingRedeliveryChannel = input.channel;
      redelivered += 1; return true;
    },
  );
  if (redelivered > 0) input.observability.event("info", "daemon.calls.redelivered_after_proven_non_delivery", { calls: redelivered });
  if (rejected > 0) input.observability.event("info", "daemon.calls.not_received_after_reconnect", { calls: rejected });
  return { redelivered, rejected };
}

function invalid(errorCode: string, errorMessage: string): ReadyMessageDisposition {
  return { ok: false, errorCode, errorMessage };
}
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
type ResumeReconciliation = {
  expectedIds: ReadonlySet<string>;
  acknowledgedMissingKey?: string;
};

export type DaemonResumeAcknowledgementDisposition = Readonly<{ ok: boolean; duplicate: boolean }>;

export type DaemonResumeAcknowledgement = Readonly<{ missingIds: readonly string[]; duplicate: boolean }>;

const reconciliations = new WeakMap<DaemonChannel, ResumeReconciliation>();

export function beginDaemonResumeReconciliation(channel: DaemonChannel, ids: readonly string[]): void {
  reconciliations.set(channel, { expectedIds: new Set(ids) });
}

export function consumeDaemonResumeAcknowledgement(
  channel: DaemonChannel,
  missingIds: readonly string[],
): DaemonResumeAcknowledgementDisposition {
  const reconciliation = reconciliations.get(channel);
  if (!reconciliation || missingIds.some((id) => !reconciliation.expectedIds.has(id))) {
    return { ok: false, duplicate: false };
  }
  const key = JSON.stringify([...missingIds].sort());
  if (reconciliation.acknowledgedMissingKey !== undefined) {
    const duplicate = reconciliation.acknowledgedMissingKey === key;
    return { ok: duplicate, duplicate };
  }
  reconciliation.acknowledgedMissingKey = key;
  return { ok: true, duplicate: false };
}

export function daemonResumeAcknowledgement(
  channel: DaemonChannel,
  value: unknown,
): DaemonResumeAcknowledgement | null {
  const missingIds = daemonResumeMissingCallIds(value);
  if (!missingIds || channel.readyState !== 1) return null;
  const disposition = consumeDaemonResumeAcknowledgement(channel, missingIds);
  return disposition.ok ? { missingIds, duplicate: disposition.duplicate } : null;
}
