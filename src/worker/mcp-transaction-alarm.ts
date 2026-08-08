export type TransactionAlarmMutation = "set" | "noop";

export async function ensureTransactionAlarmAtMost(
  transaction: Pick<DurableObjectTransaction, "getAlarm" | "setAlarm">,
  deadlineAt: number,
): Promise<TransactionAlarmMutation> {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new Error("invalid durable call alarm deadline");
  const current = await transaction.getAlarm();
  if (current !== null && current <= deadlineAt) return "noop";
  await transaction.setAlarm(deadlineAt);
  return "set";
}
