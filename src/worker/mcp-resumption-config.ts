import relayContract from "../shared/relay-contract.json" with { type: "json" };

export type McpResumptionOptions = {
  now?: () => number;
  retentionMs?: number;
  pendingRetentionMs?: number;
  maximumStreams?: number;
  maximumMessageBytes?: number;
};

export function resumptionLimits(options: McpResumptionOptions = {}): {
  retentionMs: number;
  pendingRetentionMs: number;
  maximumStreams: number;
  maximumMessageBytes: number;
} {
  const maximumRetentionMs = relayContract.streamResumeRetentionMs;
  const maximumPendingRetentionMs = relayContract.maximumRelayToolTimeoutMs + maximumRetentionMs;
  const retentionMs = Math.min(
    maximumRetentionMs,
    positiveInteger(options.retentionMs, maximumRetentionMs),
  );
  return {
    retentionMs,
    pendingRetentionMs: Math.min(
      maximumPendingRetentionMs,
      Math.max(
        retentionMs,
        positiveInteger(options.pendingRetentionMs, maximumPendingRetentionMs),
      ),
    ),
    maximumStreams: Math.min(
      relayContract.maximumResumableStreams,
      positiveInteger(options.maximumStreams, relayContract.maximumResumableStreams),
    ),
    maximumMessageBytes: Math.min(
      relayContract.maximumResumableMessageBytes,
      Math.max(512, positiveInteger(options.maximumMessageBytes, relayContract.maximumResumableMessageBytes)),
    ),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
