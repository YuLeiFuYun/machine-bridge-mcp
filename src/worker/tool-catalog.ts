import toolCatalog from "../shared/tool-catalog.json" with { type: "json" };
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
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

export type WorkerToolDefinition = Record<string, unknown> & { name: string; description: string; availability?: string };
type JsonSchema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>>; required?: string[] };

const allTools = toolCatalog as WorkerToolDefinition[];
export const workerToolSchemaGeneration = Number(serverMetadata.toolSchemaGeneration);
const HOSTED_CONTINUATION_RULE = "Do not infer or preempt a host/tool deadline from elapsed wall-clock time. While tool calls continue to be accepted and the current task still needs the result, bounded same-response follow-up may continue. Hand progress back only after an actual host/tool boundary is observed, external input or authorization is required, or the user explicitly requested a checkpoint. If an actual host/tool boundary ends the response, preserve the durable recovery identifier and resume that same operation later instead of resubmitting its underlying side effect.";
export const serverInfoTool = schemaTaggedTool(publicTool(allTools.find((tool) => tool.name === "server_info")!));
export const workspaceTools = Object.freeze(allTools.filter((tool) => tool.name !== "server_info").map(remotePublicTool).map(schemaTaggedTool));
const publicTools = [serverInfoTool, ...workspaceTools]; const workerToolArguments = compileToolArgumentValidators(publicTools);
export const workerToolParameterHeaders = toolParameterHeaderNames(publicTools);

export function validateWorkerToolArguments(name: unknown, value: unknown) {
  return workerToolArguments.validate(name, value);
}

function remotePublicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const definition = publicTool(tool);
  const schema = definition.inputSchema as JsonSchema;
  if (definition.name === "start_process") {
    definition.description = `${String(definition.description)} For hosted use, reserve process sessions for interactive stdin or incremental-output work. Prefer run_process for non-interactive work. Bounded same-response read_process follow-up is allowed when the current task needs more output or terminal state; do not busy-loop, and respect the remote blocking-poll cooldown. ${HOSTED_CONTINUATION_RULE}`;
  }
  if (definition.name === "read_process") {
    const wait = schema.properties.wait_ms;
    wait.maximum = relayContract.maximumProcessReadWaitMs;
    wait.default = relayContract.maximumProcessReadWaitMs;
    definition.description = `${String(definition.description)} Hosted reads support paced follow-up. Omitted wait_ms defaults to ${relayContract.maximumProcessReadWaitMs} ms; set wait_ms=0 only for an intentional immediate checkpoint. Remote blocking waits last at most ${relayContract.maximumProcessReadWaitMs} ms. If another would-block read arrives inside the ${relayContract.remoteProcessBlockingPollCooldownMs / 1000}-second cooldown, the daemon paces that same MCP call until output/exit or the cooldown boundary instead of returning a rapid running checkpoint. A caller may read a live session again in the same assistant response when the task needs more output or terminal state, but must not busy-loop and should respect next_blocking_poll_after_ms. Use run_process/read_job for non-interactive durable work. ${HOSTED_CONTINUATION_RULE}`;
  }
  if (definition.name === "start_job") {
    schema.required = [...new Set([...(schema.required ?? []), "idempotency_key"])];
    definition.description = `${String(definition.description)} Hosted calls require an idempotency_key known before dispatch so an ambiguous acceptance response can be recovered without creating a second job. Retry the same start_job arguments with the same idempotency_key after an unknown acceptance outcome. Hosted acceptance transfers execution to durable background ownership without forcing the current assistant response to end. When the current task needs the result, bounded same-response read_job follow-up is allowed until terminal state; do not busy-loop. ${HOSTED_CONTINUATION_RULE}`;
  }
  if (definition.name === "list_jobs") {
    definition.description = `${String(definition.description)} Hosted listing is an inventory operation, not a polling primitive. Do not repeat list_jobs merely to wait for active jobs; when following a known job, use read_job instead.`;
  }
  if (definition.name === "read_job") {
    const wait = schema.properties.wait_ms; wait.maximum = relayContract.maximumManagedJobReadWaitMs; wait.default = relayContract.defaultManagedJobReadWaitMs;
    definition.description = `${String(definition.description)} Hosted active reads use a server-side long-poll by default: wait up to ${relayContract.defaultManagedJobReadWaitMs / 1000} seconds; terminal settlement returns on the next bounded progress poll, while nonterminal progress is coalesced for at least ${relayContract.managedJobReadNonterminalProgressMinimumMs / 1000} seconds and current_step-only churn does not wake the call by itself. Set wait_ms=0 only for an immediate checkpoint. A caller may read an active job again in the same assistant response when the current task needs terminal state or further progress. Do not busy-loop or substitute repeated list_jobs calls. If the requested job is no longer retained, read_job fails with typed not_found; that absence is not proof that the underlying operation never executed, so do not blindly resubmit it. ${HOSTED_CONTINUATION_RULE}`;
  }
  if (isRemoteDurableProcessTool(definition.name)) {
    const timeout = schema.properties.timeout_seconds;
    timeout.maximum = REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS;
    timeout.default = REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS;
    schema.required = [...new Set([...schema.required!, "idempotency_key"])];
    definition.description = `${String(definition.description)} Remote calls require an idempotency_key known to the caller before dispatch, then commit as one-step durable jobs before execution; timeout_seconds controls child execution after resource admission rather than the MCP response lifetime. After durable acceptance, the original tool call waits up to ${relayContract.durableProcessInitialSettlementWaitMs} ms for a short helper to settle. A terminal initial response includes the managed-job result with follow_up_read_required=false; an active response keeps the same job_id/recovery envelope with follow_up_read_required=true. This coalesces the common helper-plus-read double event without shortening execution or weakening recovery. The managed runner may wait up to ${relayContract.maximumManagedJobResourceAdmissionWaitMs / 60_000} minutes pre-spawn for cooperative resource admission; read_job reports current_phase=resource_admission while no child has started. Reuse the same key after an ambiguous acceptance response to recover the same job. After successful acceptance, bounded same-response read_job follow-up is allowed only when the job remains active; do not busy-loop. ${HOSTED_CONTINUATION_RULE}`;
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

function schemaTaggedTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  tool.description = `${tool.description} Tool schema generation ${workerToolSchemaGeneration}.`;
  return tool;
}
