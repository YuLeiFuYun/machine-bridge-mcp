import toolCatalog from "../shared/tool-catalog.json" with { type: "json" };
import { compileToolArgumentValidators } from "../shared/tool-argument-validation.mjs";
import { toolParameterHeaderNames } from "./mcp-http-contract.ts";
import {
  isConfigurableForegroundTool,
  isRemoteDurableProcessTool,
  REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS,
  REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS,
  remoteForegroundDefaultSeconds,
  remoteForegroundMaximumSeconds,
} from "./tool-timeout.ts";
import relayContract from "../shared/relay-contract.json" with { type: "json" };

export type WorkerToolDefinition = Record<string, unknown> & { name: string; availability?: string };
type JsonSchema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>>; required?: string[] };

const allTools = toolCatalog as WorkerToolDefinition[];

export const serverInfoTool = publicTool(allTools.find((tool) => tool.name === "server_info")!);
export const workspaceTools = Object.freeze(allTools.filter((tool) => tool.name !== "server_info").map(remotePublicTool));

const publicTools = [serverInfoTool, ...workspaceTools];
const workerToolArguments = compileToolArgumentValidators(publicTools);
export const workerToolParameterHeaders = toolParameterHeaderNames(publicTools);

export function validateWorkerToolArguments(name: unknown, value: unknown) {
  return workerToolArguments.validate(name, value);
}

function remotePublicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const definition = publicTool(tool);
  const schema = definition.inputSchema as JsonSchema;
  if (definition.name === "start_process") {
    definition.description = `${String(definition.description)} For hosted use, reserve process sessions for interactive stdin or incremental-output work. Prefer run_process for non-interactive work. In one hosted assistant response, use read_process at most once for a live session; if it still reports running=true, stop polling and return the session/progress to the user even when new output was returned.`;
  }
  if (definition.name === "read_process") {
    const wait = schema.properties.wait_ms;
    wait.maximum = relayContract.maximumProcessReadWaitMs;
    definition.description = `${String(definition.description)} Hosted reads are status checkpoints. Remote blocking waits last at most ${relayContract.maximumProcessReadWaitMs} ms, and repeated would-block reads are suppressed during a ${relayContract.remoteProcessBlockingPollCooldownMs / 1000}-second cooldown. In one assistant response, call read_process at most once for a live session; if running=true, stop polling and return the current session/progress even when output was returned. Use run_process/read_job for non-interactive durable work.`;
  }
  if (definition.name === "start_job") {
    definition.description = `${String(definition.description)} Hosted acceptance is a handoff to background execution, not an instruction to wait for terminal status in the same assistant response. If a status checkpoint is useful, call read_job at most once; if the job is still active, return its job_id/status/current_phase to the user and stop polling.`;
  }
  if (definition.name === "list_jobs") {
    definition.description = `${String(definition.description)} Hosted listing is an inventory checkpoint, not a wait loop. Do not repeat list_jobs in one assistant response to wait for active jobs; return the visible job statuses and hand the turn back instead.`;
  }
  if (definition.name === "read_job") {
    definition.description = `${String(definition.description)} Hosted reads are status checkpoints, not a wait loop. In one assistant response, read an active job at most once; if its status is still active/non-terminal, return its job_id/status/current_phase to the user and stop polling. Re-read in a later user turn or when explicitly requested.`;
  }
  if (isRemoteDurableProcessTool(definition.name)) {
    const timeout = schema.properties.timeout_seconds;
    timeout.maximum = REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS;
    timeout.default = REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS;
    schema.required = [...new Set([...(schema.required || []), "idempotency_key"])];
    definition.description = `${String(definition.description)} Remote calls require an idempotency_key known to the caller before dispatch, then commit as one-step durable jobs before execution; timeout_seconds controls child execution after resource admission rather than the MCP response lifetime. The managed runner may wait up to ${relayContract.maximumManagedJobResourceAdmissionWaitMs / 60_000} minutes pre-spawn for cooperative resource admission; read_job reports current_phase=resource_admission while no child has started. Reuse the same key after an ambiguous acceptance response to recover the same job. After successful acceptance, treat read_job only as a status checkpoint; if the job is still active, return its job_id/status/current_phase to the user and stop polling in the current assistant response.`;
    return definition;
  }
  if (!isConfigurableForegroundTool(definition.name)) return definition;

  const timeout = schema.properties.timeout_seconds;
  const maximumSeconds = remoteForegroundMaximumSeconds(definition.name);
  timeout.maximum = maximumSeconds;
  timeout.default = remoteForegroundDefaultSeconds(definition.name);
  definition.description = `${String(definition.description)} Remote foreground execution is limited to ${maximumSeconds} seconds. Keep foreground interactions request-bounded and split longer browser/application workflows into independently terminal calls. For process-based long work, prefer run_process/start_job; use start_process only when interactive stdin or incremental process output is actually required.`;
  return definition;
}

function publicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const { availability: _availability, ...definition } = tool;
  return structuredClone(definition) as WorkerToolDefinition;
}
