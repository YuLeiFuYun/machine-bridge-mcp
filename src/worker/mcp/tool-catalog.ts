import toolCatalog from "../../shared/tool-catalog.json" with { type: "json" };
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { compileToolArgumentValidators } from "../../shared/tool-argument-validation.mjs";
import { tagToolSchemaGeneration } from "../../shared/mcp-protocol.mjs";
import { toolParameterHeaderNames } from "./http-contract.ts";
import { isConfigurableForegroundTool, isRemoteDurableProcessTool, REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS, REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS, remoteForegroundDefaultSeconds, remoteForegroundMaximumSeconds } from "../room/tool-timeout.ts";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { attachManagedJobMonitorMetadata, managedJobMonitorClaimToolDefinition, managedJobMonitorReadToolDefinition, managedJobMonitorRenderToolDefinition } from "./job-monitor.ts";

export type WorkerToolDefinition = Record<string, unknown> & { name: string; description: string; availability?: string };

type JsonSchema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>>; required?: string[] };

type BrowserTargetToolDefinition = Record<string, unknown> & { name: string; description: string };

type BrowserTargetJsonSchema = Record<string, unknown> & {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  allOf?: Record<string, unknown>[];
};

export const EXPLICIT_TAB_TOOLS = new Set([
  "browser_get_source",
  "browser_inspect_page",
  "browser_wait",
  "browser_action",
  "browser_fill_form",
  "browser_screenshot",
  "browser_upload_files",
  "browser_network_log",
]);

function applyHostedBrowserTargetContract(definition: BrowserTargetToolDefinition, schema: BrowserTargetJsonSchema): void {
  if (EXPLICIT_TAB_TOOLS.has(definition.name)) {
    schema.required = [...new Set([...(schema.required ?? []), "tab_id"])];
    definition.description = `${definition.description} Hosted calls require an explicit tab_id obtained from browser_list_tabs; they never fall back to whichever tab happens to be active, so concurrent hosted conversations cannot retarget this operation merely by changing browser focus.`;
    return;
  }
  if (definition.name === "computer_observe") {
    schema.allOf = [...(schema.allOf ?? []), {
      if: { properties: { surface: { const: "browser" } }, required: ["surface"] },
      then: { required: ["tab_id"] },
    }];
    definition.description = `${definition.description} Hosted browser observations require an explicit tab_id; the returned snapshot then binds later computer_act operations to that observed browser target.`;
  }
}

type ResultBudgetToolDefinition = { name: string; description?: unknown };

type ToolSchema = { properties: Record<string, Record<string, unknown>> };

type HostedResultContract = {
  maximumHostedReadFileResultBytes: number;
  maximumHostedProcessReadBytes: number;
};

const DURABLE_PROCESS_HELPERS = new Set(["exec_command", "run_process", "run_local_command"]);

function applyHostedResultBudgetContract(definition: ResultBudgetToolDefinition, schema: ToolSchema, contract: HostedResultContract) {
  if (definition.name === "read_file") {
    boundBytes(schema.properties.max_bytes, contract.maximumHostedReadFileResultBytes);
    definition.description = `${String(definition.description)} Hosted calls cap the complete serialized read_file result at ${contract.maximumHostedReadFileResultBytes} bytes. Omit end_line to permit automatic whole-line pagination; a paged result returns complete=false and next_start_line. An explicit range or individual line that cannot fit returns limit_exceeded. Local/stdio read capacity is unchanged.`;
  }
  if (definition.name === "read_process") {
    boundBytes(schema.properties.max_bytes, contract.maximumHostedProcessReadBytes);
    definition.description = `${String(definition.description)} Hosted max_bytes defaults to and is capped at ${contract.maximumHostedProcessReadBytes} bytes per read; local/stdio read capacity is unchanged.`;
  }
  if (DURABLE_PROCESS_HELPERS.has(definition.name)) {
    definition.description = `${String(definition.description)} If complete large stdout/stderr is required, redirect it to a file and consume it through bounded read_file pages rather than returning one large terminal payload.`;
  }
}

function boundBytes(property: Record<string, unknown> | undefined, maximum: number) {
  if (!property) return;
  property.maximum = maximum;
  property.default = maximum;
}

type ManagedJobToolDefinition = Record<string, unknown> & { name: string; description: string };

type ManagedJobJsonSchema = Record<string, unknown> & {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  allOf?: Record<string, unknown>[];
};

type RelayContract = {
  defaultManagedJobReadWaitMs: number;
  maximumManagedJobReadWaitMs: number;
  managedJobReadNonterminalProgressMinimumMs: number;
};

const READ_KEY_SCHEMA = { type: "string", pattern: "^mcp_jr_[A-Za-z0-9_-]{43}$" };

const CONTROL_KEY_SCHEMA = { type: "string", pattern: "^mcp_jc_[A-Za-z0-9_-]{43}$" };

const MONITOR_ID_SCHEMA = { type: "string", pattern: "^mcp_jm_[a-f0-9]{32}$" };

const DEPENDENCY_RECOVERY_SCHEMA = {
  type: "object",
  maxProperties: 16,
  additionalProperties: READ_KEY_SCHEMA,
};

function applyHostedManagedJobToolContract(
  definition: ManagedJobToolDefinition,
  schema: ManagedJobJsonSchema,
  relay: RelayContract,
  continuationRule: string,
  options: { includeJobMonitor?: boolean } = {},
): boolean {
  const includeJobMonitor = options.includeJobMonitor !== false;
  if (definition.name === "stage_job" || definition.name === "start_job") {
    schema.properties.dependency_recovery = DEPENDENCY_RECOVERY_SCHEMA;
    schema.allOf = [...(schema.allOf ?? []), {
      if: { properties: { depends_on: { minItems: 1 } }, required: ["depends_on"] },
      then: { required: ["dependency_recovery"] },
    }];
    if (definition.name === "start_job") {
      schema.required = [...new Set([...(schema.required ?? []), "idempotency_key"])];
      const monitorGuidance = includeJobMonitor
        ? " On an MCP Apps-capable host, an active result may report ui_monitor_candidate=true plus ui_monitor_render_tool=render_job_monitor and a fresh non-secret ui_monitor_id. That is an optional job-status surface, not automatic task handoff. If remaining same-response work needs the managed job's terminal result, do not render the monitor; preserve job_id plus recovery_key and continue bounded server-paced read_job calls. Render only when the current assistant task can deliberately transfer this job's status polling. When intentionally rendering, preserve the pre-issued ID, call render_job_monitor once with the exact job_id, recovery_key, and ui_monitor_id, then call read_job with the same ID without depending on the render result being planner-visible. A matching current View claim on an ordinary job reports ui_monitor_claimed=true, status_polling_mode=ui_monitor, host_turn_handoff_recommended=false, and follow_up_read_required=false: the View owns duplicate status polling for that job only and does not own unrelated assistant work or require ending the response. If and only if the persisted active job declares continuation_mode=task_supervisor, the same proven current claim may report host_turn_handoff_recommended=true; that is safe because the durable supervisor already owns all remaining noninteractive task work, not because the View owns assistant execution. continuation_mode=task_supervisor must be omitted for ordinary child jobs and grants no new execution or capability authority."
        : "";
      definition.description = `${definition.description} Hosted calls require an idempotency_key known before dispatch. Accepted hosted jobs return principal-bound recovery_key and control_key capabilities; use recovery_key for read_job and dependency references, and control_key for cancel_job. Dependency references require dependency_recovery entries for every depends_on job.${monitorGuidance} ${continuationRule}`;
    } else {
      definition.description = `${definition.description} Hosted staged jobs return principal-bound recovery_key and control_key capabilities. Dependency references require dependency_recovery entries for every depends_on job. Local CLI/stdio administration remains the global inventory surface.`;
    }
    return true;
  }
  if (definition.name === "list_jobs") {
    definition.description = `${definition.description} Hosted listing returns aggregate retained/capacity/activity state only and deliberately omits job handles, names, and recent_process_recovery so independent hosted conversations cannot discover each other's durable recovery identifiers. Recover a known job with read_job plus its recovery_key; use local CLI/stdio for global administration. This remains an inventory operation, not a polling primitive; do not repeat list_jobs merely to wait for active jobs.`;
    return true;
  }
  if (definition.name === "read_job") {
    schema.properties.recovery_key = READ_KEY_SCHEMA;
    if (includeJobMonitor) schema.properties.ui_monitor_id = MONITOR_ID_SCHEMA;
    schema.required = [...new Set([...(schema.required ?? []), "recovery_key"])];
    const wait = schema.properties.wait_ms;
    if (wait === undefined) throw new Error("hosted read_job schema is missing the wait_ms property");
    wait.maximum = relay.maximumManagedJobReadWaitMs;
    wait.default = relay.defaultManagedJobReadWaitMs;
    const monitorReadGuidance = includeJobMonitor
      ? " Do not render_job_monitor merely to avoid waiting when remaining task work needs this job's terminal result. If a monitor was deliberately rendered, pass the same ui_monitor_id that the preceding active start_job already returned; do not wait for or infer an ID from the render result. A matching claim on an ordinary job may report ui_monitor_claimed=true with status_polling_mode=ui_monitor, host_turn_handoff_recommended=false, and follow_up_read_required=false. That means the View owns further status polling for this job only; it does not imply that the assistant should finish unrelated or still-actionable work. For a persisted active continuation_mode=task_supervisor job, the same proven current claim may instead report host_turn_handoff_recommended=true because the supervisor itself already encapsulates all remaining noninteractive task work; the monitor still has status-only authority."
      : "";
    definition.description = `${definition.description} Hosted reads require the principal-bound recovery_key returned when the job was accepted; a job_id alone is not remote read authority. Hosted active reads use a server-side long-poll by default: wait up to ${relay.defaultManagedJobReadWaitMs / 1000} seconds, with a public wait_ms maximum of ${relay.maximumManagedJobReadWaitMs / 1000} seconds. Nonterminal progress is coalesced for at least ${relay.managedJobReadNonterminalProgressMinimumMs / 1000} seconds. A caller may read an active job again in the same assistant response when terminal state or further progress is required; do not busy-loop.${monitorReadGuidance} ${continuationRule}`;
    return true;
  }
  if (definition.name === "cancel_job") {
    schema.properties.control_key = CONTROL_KEY_SCHEMA;
    schema.required = [...new Set([...(schema.required ?? []), "control_key"])];
    definition.description = `${definition.description} Hosted cancellation requires the principal-bound control_key returned when the job was accepted; a job_id or recovery_key alone is not cancellation authority.`;
    return true;
  }
  return false;
}

const allTools = toolCatalog as WorkerToolDefinition[];

export const workerToolSchemaGeneration = Number(serverMetadata.toolSchemaGeneration);

const HOSTED_CONTINUATION_RULE = "Do not infer or preempt a host/tool deadline from elapsed wall-clock time. While tool calls continue to be accepted and the current task still needs the result, bounded same-response follow-up may continue. Hand progress back only after an actual host/tool boundary is observed, external input or authorization is required, or the user explicitly requested a checkpoint. If an actual host/tool boundary ends the response, preserve the durable recovery identifier and resume that same operation later instead of resubmitting its underlying side effect.";

export const serverInfoTool = schemaTaggedTool(workerServerInfoTool(publicTool(allTools.find((tool) => tool.name === "server_info")!)));

export const jobMonitorRenderTool = schemaTaggedTool(managedJobMonitorRenderToolDefinition() as WorkerToolDefinition);

export const jobMonitorClaimTool = schemaTaggedTool(managedJobMonitorClaimToolDefinition() as WorkerToolDefinition);

export const jobMonitorReadTool = schemaTaggedTool(managedJobMonitorReadToolDefinition() as WorkerToolDefinition);

const rawWorkspaceTools = allTools.filter((tool) => tool.name !== "server_info");

export const workspaceTools = Object.freeze(rawWorkspaceTools.map((tool) => schemaTaggedTool(remotePublicTool(tool, true))));

export const workspaceToolsPlain = Object.freeze(rawWorkspaceTools.map((tool) => schemaTaggedTool(remotePublicTool(tool, false))));

const publicTools = [serverInfoTool, jobMonitorRenderTool, jobMonitorClaimTool, jobMonitorReadTool, ...workspaceTools];

const plainPublicTools = [serverInfoTool, ...workspaceToolsPlain];

const workerToolArguments = compileToolArgumentValidators(publicTools);

const workerPlainToolArguments = compileToolArgumentValidators(plainPublicTools);

export const workerToolParameterHeaders = toolParameterHeaderNames(publicTools);

export function validateWorkerToolArguments(name: unknown, value: unknown, includeJobMonitor = true) {
  return (includeJobMonitor ? workerToolArguments : workerPlainToolArguments).validate(name, value);
}

function remotePublicTool(tool: WorkerToolDefinition, includeJobMonitor = true): WorkerToolDefinition {
  const definition = publicTool(tool);
  const schema = definition.inputSchema as JsonSchema;
  if (includeJobMonitor) attachManagedJobMonitorMetadata(definition);
  if (definition.name === "start_process") {
    definition.description = `${String(definition.description)} For hosted use, reserve process sessions for interactive stdin or incremental-output work. Prefer run_process for non-interactive work. Bounded same-response read_process follow-up is allowed when the current task needs more output or terminal state; do not busy-loop, and respect the remote blocking-poll cooldown. ${HOSTED_CONTINUATION_RULE}`;
  }
  if (definition.name === "read_process") {
    const wait = schemaProperty(schema, "wait_ms");
    wait.maximum = relayContract.maximumProcessReadWaitMs;
    wait.default = relayContract.maximumProcessReadWaitMs;
    definition.description = `${String(definition.description)} Hosted reads support paced follow-up. Omitted wait_ms defaults to ${relayContract.maximumProcessReadWaitMs} ms; set wait_ms=0 only for an intentional immediate checkpoint. Remote blocking waits last at most ${relayContract.maximumProcessReadWaitMs} ms. If another would-block read arrives inside the ${relayContract.remoteProcessBlockingPollCooldownMs / 1000}-second cooldown, the daemon paces that same MCP call until output/exit or the cooldown boundary instead of returning a rapid running checkpoint. A caller may read a live session again in the same assistant response when the task needs more output or terminal state, but must not busy-loop and should respect next_blocking_poll_after_ms. Use run_process/read_job for non-interactive durable work. ${HOSTED_CONTINUATION_RULE}`;
  }
  applyHostedManagedJobToolContract(definition, schema, relayContract, HOSTED_CONTINUATION_RULE, { includeJobMonitor });
  applyHostedBrowserTargetContract(definition, schema);
  applyHostedResultBudgetContract(definition, schema, relayContract);
  if (isRemoteDurableProcessTool(definition.name)) {
    const timeout = schemaProperty(schema, "timeout_seconds");
    timeout.maximum = REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS;
    timeout.default = REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS;
    schema.required = [...new Set([...schema.required!, "idempotency_key"])];
    const outputSchema = definition.outputSchema as JsonSchema | undefined;
    if (outputSchema && typeof outputSchema === "object") {
      outputSchema.required = ["accepted", "job_id", "name", "status", "execution_mode", "source_tool", "recovery", "cleanup"];
    }
    definition.description = `${String(definition.description)} Remote calls require an idempotency_key known to the caller before dispatch, then commit as one-step durable jobs before execution; timeout_seconds controls child execution after resource admission rather than the MCP response lifetime. After durable acceptance, the original tool call waits up to ${relayContract.durableProcessInitialSettlementWaitMs} ms for a short helper to settle. A terminal initial response includes the managed-job result with follow_up_read_required=false; an active response keeps the same job_id/recovery envelope with follow_up_read_required=true, including the principal-bound recovery_key and control_key added by the Worker. This coalesces the common helper-plus-read double event without shortening execution or weakening recovery. The managed runner may wait up to ${relayContract.maximumManagedJobResourceAdmissionWaitMs / 60_000} minutes pre-spawn for cooperative resource admission; read_job reports current_phase=resource_admission while no child has started. Reuse the same idempotency key after an ambiguous acceptance response to recover the same accepted job/result. After successful acceptance, bounded same-response read_job follow-up uses the returned job_id plus recovery_key and is allowed only when the job remains active; do not busy-loop. ${HOSTED_CONTINUATION_RULE}`;
    return definition;
  }
  if (!isConfigurableForegroundTool(definition.name)) return definition;

  const timeout = schemaProperty(schema, "timeout_seconds");
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

function workerServerInfoTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const outputSchema = tool.outputSchema as JsonSchema | undefined;
  if (outputSchema && typeof outputSchema === "object") {
    outputSchema.required = ["name", "version", "authorization", "daemon", "worker", "tool_delivery"];
  }
  return tool;
}

function schemaProperty(schema: JsonSchema, name: string): Record<string, unknown> { const property = schema.properties[name]; if (property === undefined) throw new Error(`hosted tool schema is missing the ${name} property`); return property; }

function schemaTaggedTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  return tagToolSchemaGeneration(tool, workerToolSchemaGeneration) as WorkerToolDefinition;
}
