import relayContract from "../shared/relay-contract.json" with { type: "json" };
import {
  isConfigurableForegroundTool,
  remoteForegroundDefaultSeconds,
  remoteForegroundMaximumSeconds,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS,
} from "../shared/foreground-timeout.mjs";
import { WorkerToolError } from "./errors.ts";

export {
  isConfigurableForegroundTool,
  remoteForegroundDefaultSeconds,
  remoteForegroundMaximumSeconds,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS,
  REMOTE_PROCESS_FOREGROUND_TIMEOUT_SECONDS,
} from "../shared/foreground-timeout.mjs";

export type DaemonToolTimeoutBudget = Readonly<{
  executionTimeoutMs: number;
  settlementTimeoutMs: number;
}>;

export function daemonToolTimeoutBudget(name: string, args: Record<string, unknown>): DaemonToolTimeoutBudget {
  const executionTimeoutMs = toolExecutionTimeoutMs(name, args);
  const settlementTimeoutMs = Math.min(
    executionTimeoutMs + relayContract.workerSettlementOverheadMs,
    relayContract.maximumRelayToolTimeoutMs,
  );
  return Object.freeze({ executionTimeoutMs, settlementTimeoutMs });
}

function toolExecutionTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name === "session_bootstrap") return 10_000;
  if (!isConfigurableForegroundTool(name)) return 60_000;

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
