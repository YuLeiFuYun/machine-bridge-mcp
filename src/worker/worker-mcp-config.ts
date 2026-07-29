import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import { serverImplementation } from "../shared/mcp-protocol.mjs";

export const SERVER_NAME = String(serverMetadata.name);
export const MCP_MODERN_PROTOCOL_VERSIONS = Object.freeze(
  serverMetadata.modernProtocolVersions.map((value) => String(value)),
);
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze(
  serverMetadata.legacyProtocolVersions.map((value) => String(value)),
);
export const MCP_INSTRUCTIONS = serverMetadata.instructions.map((value) => String(value)).join("\n");
export const MCP_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
export const MCP_DISCOVERY_TTL_MS = 300_000;
export const MCP_TOOL_LIST_TTL_MS = 300_000;

export function mcpServerInfo(version: string): Readonly<Record<string, unknown>> {
  return Object.freeze(serverImplementation({
    name: SERVER_NAME,
    title: "Machine Bridge MCP",
    version,
    description: "Workspace-scoped local coding tools over authenticated remote relay.",
  }));
}
