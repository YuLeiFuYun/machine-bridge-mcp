import {
  managedJobReadArgumentsWithinExecutionBudget, managedJobReadExecutionBudgetHasHeadroom,
} from "./managed-job-read-timeout.ts";

export function daemonToolRedeliveryArguments(
  name: string, args: Record<string, unknown>, remainingExecutionMs: number,
): Record<string, unknown> | null {
  if (!Number.isSafeInteger(remainingExecutionMs) || remainingExecutionMs < 1_000) return null;
  if (name !== "read_job") return args;
  if (managedJobReadExecutionBudgetHasHeadroom(remainingExecutionMs)) {
    return managedJobReadArgumentsWithinExecutionBudget(args, remainingExecutionMs);
  }
  return { ...args, wait_ms: 0 };
}
