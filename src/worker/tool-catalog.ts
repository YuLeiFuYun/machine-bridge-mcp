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
  if (definition.name === "read_process") {
    const wait = schema.properties.wait_ms;
    wait.maximum = relayContract.maximumProcessReadWaitMs;
    definition.description = `${String(definition.description)} Remote polling waits at most ${relayContract.maximumProcessReadWaitMs} ms per call; poll again or use read_job for durable work instead of holding one response open.`;
  }
  if (isRemoteDurableProcessTool(definition.name)) {
    const timeout = schema.properties.timeout_seconds;
    timeout.maximum = REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS;
    timeout.default = REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS;
    schema.required = [...new Set([...(schema.required || []), "idempotency_key"])];
    definition.description = `${String(definition.description)} Remote calls require an idempotency_key known to the caller before dispatch, then commit as one-step durable jobs before execution; timeout_seconds controls the detached step rather than the MCP response lifetime. Reuse the same key after an ambiguous acceptance response to recover the same job, and use the returned job_id with read_job after successful acceptance.`;
    return definition;
  }
  if (!isConfigurableForegroundTool(definition.name)) return definition;

  const timeout = schema.properties.timeout_seconds;
  const maximumSeconds = remoteForegroundMaximumSeconds(definition.name);
  timeout.maximum = maximumSeconds;
  timeout.default = remoteForegroundDefaultSeconds(definition.name);
  definition.description = `${String(definition.description)} Remote foreground execution is limited to ${maximumSeconds} seconds; use process sessions or managed jobs for longer work.`;
  return definition;
}

function publicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const { availability: _availability, ...definition } = tool;
  return structuredClone(definition) as WorkerToolDefinition;
}
