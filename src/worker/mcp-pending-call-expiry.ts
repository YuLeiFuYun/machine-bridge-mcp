export function positiveDelay(value: unknown): number {
  return Math.max(1, Math.floor(Number(value) || 1));
}

export function extendAttachedCallExpiry(
  currentExpiry: number,
  operationDeadline: number,
  terminalRetentionMs: number,
): number {
  return Math.max(currentExpiry, operationDeadline + terminalRetentionMs);
}

export function extendDetachedCallExpiry(
  currentExpiry: number,
  reconnectDeadline: number,
  remainingOperationMs: number,
  terminalRetentionMs: number,
): number {
  return Math.max(currentExpiry, reconnectDeadline + remainingOperationMs + terminalRetentionMs);
}
