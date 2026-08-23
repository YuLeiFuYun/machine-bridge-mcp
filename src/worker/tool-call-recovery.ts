import { isRemoteDurableProcessTool } from "./tool-timeout.ts";

export function daemonToolRecovery(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  if (name !== "start_job" && !isRemoteDurableProcessTool(name)) return null;
  const idempotencyKey = args.idempotency_key;
  if (typeof idempotencyKey !== "string" || !idempotencyKey) return null;
  return {
    mode: "idempotent_replay",
    source_tool: name,
    credential: "idempotency_key",
    credential_source: "original_request_arguments",
    action: "retry_same_tool_arguments_with_same_idempotency_key",
    result_tool_after_acceptance: "read_job",
    duplicate_execution_prevented_by_key: true,
  };
}
