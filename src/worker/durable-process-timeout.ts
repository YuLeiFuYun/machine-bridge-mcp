import relayContract from "../shared/relay-contract.json" with { type: "json" };
import {
  remoteDurableProcessTimeoutSeconds,
  REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
} from "../shared/foreground-timeout.mjs";
import { WorkerToolError } from "./errors.ts";

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
