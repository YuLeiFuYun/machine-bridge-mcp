export async function boundedStreamAttempt<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) throw abortReason(parentSignal);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(abortReason(parentSignal));
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const parsedTimeout = Number(timeoutMs);
  const boundedTimeout = Number.isFinite(parsedTimeout)
    ? Math.max(1, Math.min(30_000, Math.floor(parsedTimeout)))
    : 5_000;
  const timeout = setTimeout(() => {
    controller.abort(new Error("internal MCP stream attempt timed out"));
  }, boundedTimeout);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("internal MCP stream attempt cancelled");
}
