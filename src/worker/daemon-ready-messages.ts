import { acknowledgeAuthorityRevocation, authorityRevocationAckId } from "./authority-revocations.ts";
import type { DaemonChannel } from "./daemon-channel.ts";
import { daemonResumeMissingCallIds } from "./websocket-protocol.ts";
import { daemonCallNotReceivedAfterReconnectError, daemonToolError } from "./errors.ts";
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import type { PendingCallRegistry } from "./pending-calls.ts";
import type { WorkerObservability } from "./observability.ts";
import { trySendDaemonChannel } from "./daemon-channel.ts";

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
}): Promise<ReadyMessageDisposition> {
  const { channel, body, pending, storage, observability } = input;
  if (body.type === "resume_calls_ack") {
    const missingIds = daemonResumeMissingCallIds(body.missing_ids);
    if (!missingIds) return invalid("invalid_resume_calls_ack", "invalid resume calls acknowledgement");
    await settleDaemonProvenMissingCalls({ ids: missingIds, channel, pending, observability });
    return { ok: true };
  }
  if (body.type === "authority_revoke_ack") {
    const revocationId = authorityRevocationAckId(body.revocation_id);
    if (!revocationId) return invalid("invalid_authority_revoke_ack", "invalid authority revocation acknowledgement");
    await acknowledgeAuthorityRevocation(storage, revocationId);
    return { ok: true };
  }
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
      if (record.redeliverAfterProvenMissing?.(record, input.channel) !== true) return false;
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
