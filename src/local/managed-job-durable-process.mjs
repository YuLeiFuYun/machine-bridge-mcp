import { BridgeError } from "./errors.mjs";
import { REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS } from "../shared/foreground-timeout.mjs";

const DURABLE_PROCESS_SOURCE_TOOLS = new Set(["exec_command", "run_process", "run_local_command"]);

export function startDurableProcessJob(manager, args = {}, context = {}) {
  const sourceTool = String(args.sourceTool || "");
  if (!DURABLE_PROCESS_SOURCE_TOOLS.has(sourceTool)) {
    throw new BridgeError("invalid_request", "durable process execution requires a supported process source tool");
  }
  manager.authorizeTool(sourceTool);
  manager.assertMaintenanceAvailable();
  const timeoutSeconds = args.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS) {
    throw new BridgeError("invalid_request", `durable process execution timeout must be an integer from 1 to ${REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS} seconds`);
  }
  const accepted = manager.createJob({
    name: String(args.name || `durable ${sourceTool}`).slice(0, 128),
    ...(args.idempotencyKey === undefined ? {} : { idempotency_key: args.idempotencyKey }),
    steps: [{
      name: sourceTool,
      argv: args.argv,
      cwd: args.cwd,
      timeout_seconds: timeoutSeconds,
      capture_output: "redacted",
    }],
  }, {
    launch: true,
    executionPriority: "interactive",
    delegatedProcess: args.delegatedProcess === true,
  }, context);
  return {
    ...accepted,
    execution_mode: "durable_job",
    source_tool: sourceTool,
    execution_timeout_seconds: timeoutSeconds,
    progress: { status: accepted.status, current_phase: null, current_step: null },
    recovery: {
      tool: "read_job",
      job_id: accepted.job_id,
      fallback_tool: "list_jobs",
      survives_mcp_disconnect: true,
      survives_daemon_restart: true,
    },
    retry_safety: args.idempotencyKey === undefined
      ? "retain job_id and inspect list_jobs before resubmitting after an ambiguous acceptance failure"
      : "retry the same tool arguments with the same idempotency_key to recover the same durable job",
  };
}
