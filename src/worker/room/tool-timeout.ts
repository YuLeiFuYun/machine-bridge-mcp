import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { isConfigurableForegroundTool, isRemoteDurableProcessTool, remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds, REMOTE_FOREGROUND_TIMEOUT_SECONDS, remoteDurableProcessTimeoutSeconds, REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS } from "../../shared/foreground-timeout.mjs";
import { WorkerToolError } from "./errors.ts";
import { managedJobReadTimeoutBudget } from "./managed-job-contract.ts";

export {
  isConfigurableForegroundTool,
  isRemoteDurableProcessTool,
  remoteDurableProcessTimeoutSeconds,
  REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
  remoteForegroundDefaultSeconds,
  remoteForegroundMaximumSeconds,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS,
} from "../../shared/foreground-timeout.mjs";

export type DaemonToolTimeoutBudget = Readonly<{ executionTimeoutMs: number; settlementTimeoutMs: number }>;

export function daemonToolTimeoutBudget(name: string, args: Record<string, unknown>): DaemonToolTimeoutBudget {
  if (name === "read_job") return managedJobReadTimeoutBudget(args);
  const executionTimeoutMs = toolExecutionTimeoutMs(name, args);
  const settlementTimeoutMs = Math.min(
    executionTimeoutMs + relayContract.workerSettlementOverheadMs,
    relayContract.maximumOrdinaryRelayToolTimeoutMs,
  );
  return Object.freeze({ executionTimeoutMs, settlementTimeoutMs });
}

function toolExecutionTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name === "session_bootstrap") return 10_000;
  if (name === "read_process") {
    const waitMs = typeof args.wait_ms === "number" && Number.isSafeInteger(args.wait_ms)
      ? Math.max(0, Math.min(args.wait_ms, relayContract.maximumProcessReadWaitMs))
      : relayContract.maximumProcessReadWaitMs;
    return waitMs === 0 ? 5_000 : relayContract.defaultRemoteToolExecutionTimeoutMs;
  }
  if (name === "start_process") {
    return Math.min(relayContract.processSessionStartExecutionTimeoutMs, relayContract.defaultRemoteToolExecutionTimeoutMs);
  }
  if (isRemoteDurableProcessTool(name)) return durableProcessAcceptanceTimeoutMs(name, args);
  if (!isConfigurableForegroundTool(name)) return relayContract.defaultRemoteToolExecutionTimeoutMs;
  const seconds = remoteForegroundSeconds(name, args.timeout_seconds);
  return Math.min(seconds * 1000, relayContract.maximumExecutionTimeoutMs);
}

function remoteForegroundSeconds(name: string, value: unknown): number {
  if (value === undefined) return remoteForegroundDefaultSeconds(name);
  const maximumSeconds = remoteForegroundMaximumSeconds(name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw foregroundTimeoutError("remote foreground timeout must be an integer of at least 1 second", maximumSeconds);
  }
  if (value > maximumSeconds) {
    throw foregroundTimeoutError(
      `remote foreground timeout exceeds ${maximumSeconds} seconds for ${name}; split mutations from verification and use start_process/read_process or start_job/read_job for longer work`,
      maximumSeconds,
    );
  }
  return value;
}

function foregroundTimeoutError(message: string, maximumSeconds = REMOTE_FOREGROUND_TIMEOUT_SECONDS): WorkerToolError {
  return new WorkerToolError(
    "invalid_request",
    message,
    false,
    {
      side_effects_started: false,
      minimum_foreground_timeout_seconds: 1,
      maximum_foreground_timeout_seconds: maximumSeconds,
      recommended_tools: ["start_process", "read_process", "start_job", "read_job"],
    },
  );
}
export function durableProcessAcceptanceTimeoutMs(name: string, args: Record<string, unknown>): number {
  try { remoteDurableProcessTimeoutSeconds(args.timeout_seconds); }
  catch { throw durableProcessTimeoutError(name); }
  return relayContract.durableProcessAcceptanceTimeoutMs;
}

function durableProcessTimeoutError(name: string): WorkerToolError {
  return new WorkerToolError(
    "invalid_request",
    `durable remote execution timeout for ${name} must be an integer from 1 to ${REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS} seconds`,
    false,
    {
      side_effects_started: false,
      minimum_execution_timeout_seconds: 1,
      maximum_execution_timeout_seconds: REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
      default_execution_timeout_seconds: REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS,
      execution_mode: "durable_job",
      recovery_tool: "read_job",
    },
  );
}
export function daemonToolRecovery(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  if (name === "read_job") {
    const jobId = args.job_id;
    if (typeof jobId !== "string" || !jobId) return null;
    return {
      mode: "read_same_job",
      source_tool: name,
      credential: "job_id+recovery_key",
      credential_source: "original_request_arguments",
      job_id: jobId,
      action: "retry_read_job_with_same_job_id_and_recovery_key",
      duplicate_execution_prevented_by_read_only_operation: true,
    };
  }
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
