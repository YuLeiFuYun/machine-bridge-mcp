import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { serverImplementation } from "../shared/mcp-protocol.mjs";
import { MCP_APP_MIME_TYPE, MCP_UI_EXTENSION_ID } from "./mcp-job-monitor-ui.ts";

export const SERVER_NAME = String(serverMetadata.name);
export const MCP_PROTOCOL_VERSIONS = Object.freeze(
  serverMetadata.supportedProtocolVersions.map((value) => String(value)),
);
export const MCP_INITIALIZATION_COMPATIBILITY_VERSIONS = Object.freeze(
  serverMetadata.remoteHttpInitializationCompatibilityVersions.map((value) => String(value)),
);
export const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");
export const MCP_SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({ listChanged: true }),
  resources: Object.freeze({}),
  extensions: Object.freeze({ [MCP_UI_EXTENSION_ID]: Object.freeze({ mimeTypes: Object.freeze([MCP_APP_MIME_TYPE]) }) }),
});
export const MCP_LEGACY_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
export const MCP_DISCOVERY_TTL_MS = 0;
// Tool descriptions carry execution/orchestration semantics. Do not advertise a
// reusable tools/list cache across package/Worker replacement; a host that asks
// again should always receive the current schema/description set.
export const MCP_TOOL_LIST_TTL_MS = 0;

export function mcpServerInfo(version: string): Readonly<Record<string, unknown>> {
  return Object.freeze(serverImplementation({
    name: SERVER_NAME,
    title: "Machine Bridge MCP",
    version,
    description: "Workspace-scoped local coding tools over authenticated remote relay.",
  }));
}
