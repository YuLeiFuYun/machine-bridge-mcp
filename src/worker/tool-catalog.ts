import toolCatalog from "../shared/tool-catalog.json";

export type WorkerToolDefinition = Record<string, unknown> & { name: string; availability?: string };

const allTools = toolCatalog as WorkerToolDefinition[];

export const serverInfoTool = publicTool(allTools.find((tool) => tool.name === "server_info")!);
export const workspaceTools = Object.freeze(allTools.filter((tool) => tool.name !== "server_info").map(publicTool));

function publicTool(tool: WorkerToolDefinition): WorkerToolDefinition {
  const { availability: _availability, ...definition } = tool;
  return structuredClone(definition) as WorkerToolDefinition;
}
