type ToolDefinition = Record<string, unknown> & { name: string; description: string };
type JsonSchema = Record<string, unknown> & {
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

export function applyHostedManagedJobToolContract(
  definition: ToolDefinition,
  schema: JsonSchema,
  relay: RelayContract,
  continuationRule: string,
): boolean {
  if (definition.name === "stage_job" || definition.name === "start_job") {
    schema.properties.dependency_recovery = DEPENDENCY_RECOVERY_SCHEMA;
    schema.allOf = [...(schema.allOf ?? []), {
      if: { properties: { depends_on: { minItems: 1 } }, required: ["depends_on"] },
      then: { required: ["dependency_recovery"] },
    }];
    if (definition.name === "start_job") {
      schema.required = [...new Set([...(schema.required ?? []), "idempotency_key"])];
      definition.description = `${definition.description} Hosted calls require an idempotency_key known before dispatch. Accepted hosted jobs return principal-bound recovery_key and control_key capabilities; use recovery_key for read_job and dependency references, and control_key for cancel_job. Dependency references require dependency_recovery entries for every depends_on job. On an MCP Apps-capable host, an active result may report ui_monitor_candidate=true plus ui_monitor_render_tool=render_job_monitor. That is not yet a handoff: call render_job_monitor once with the exact job_id and recovery_key, then call read_job with the render result's ui_monitor_id. Only a later active read with the matching current View claim reports ui_monitor_claimed=true, status_polling_mode=ui_monitor, host_turn_handoff_recommended=true, and follow_up_read_required=false; then end model-side polling. ${continuationRule}`;
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
    schema.properties.ui_monitor_id = MONITOR_ID_SCHEMA;
    schema.required = [...new Set([...(schema.required ?? []), "recovery_key"])];
    const wait = schema.properties.wait_ms;
    wait.maximum = relay.maximumManagedJobReadWaitMs;
    wait.default = relay.defaultManagedJobReadWaitMs;
    definition.description = `${definition.description} Hosted reads require the principal-bound recovery_key returned when the job was accepted; a job_id alone is not remote read authority. Hosted active reads use a server-side long-poll by default: wait up to ${relay.defaultManagedJobReadWaitMs / 1000} seconds, with a public wait_ms maximum of ${relay.maximumManagedJobReadWaitMs / 1000} seconds. Nonterminal progress is coalesced for at least ${relay.managedJobReadNonterminalProgressMinimumMs / 1000} seconds. A caller may read an active job again in the same assistant response when terminal state or further progress is required; do not busy-loop. After render_job_monitor, pass its ui_monitor_id on the next read. If that exact read reports ui_monitor_claimed=true together with status_polling_mode=ui_monitor and host_turn_handoff_recommended=true, the current mounted View has proven app-origin server-tool access; stop model-side reads and finish the response while that UI owns continuation. ${continuationRule}`;
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
