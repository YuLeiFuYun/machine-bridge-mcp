import toolCatalog from "../shared/tool-catalog.json" with { type: "json" };
import {
  isConfigurableForegroundTool,
  remoteForegroundDefaultSeconds,
  REMOTE_FOREGROUND_TIMEOUT_SECONDS,
} from "./tool-timeout.ts";

export type WorkerToolDefinition = Record<string, unknown> & { name: string; availability?: string };
type JsonSchema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };

const allTools = toolCatalog as WorkerToolDefinition[];

export const serverInfoTool = publicTool(allTools.find((tool) => tool.name === "server_info")!);
export const workspaceTools = Object.freeze(allTools.filter((tool) => tool.name !== "server_info").map(remotePublicTool));

function remotePublicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const definition = publicTool(tool);
  if (!isConfigurableForegroundTool(definition.name)) return definition;

  const schema = definition.inputSchema as JsonSchema;
  const timeout = schema.properties.timeout_seconds;
  timeout.maximum = REMOTE_FOREGROUND_TIMEOUT_SECONDS;
  timeout.default = remoteForegroundDefaultSeconds(definition.name);
  definition.description = `${String(definition.description)} Remote foreground execution is limited to ${REMOTE_FOREGROUND_TIMEOUT_SECONDS} seconds; use process sessions or managed jobs for longer work.`;
  return definition;
}

function publicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const { availability: _availability, ...definition } = tool;
  return structuredClone(definition) as WorkerToolDefinition;
}
