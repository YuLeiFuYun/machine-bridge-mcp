import type { DaemonChannel } from "./daemon-channel.ts";
import { daemonResumeMissingCallIds } from "./websocket-protocol.ts";

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
