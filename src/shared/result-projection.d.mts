export const MCP_TEXT_PROJECTION_KEY: "$mcpText";
export function mirroredResultText(value: unknown): string;
export function projectMcpResult(value: unknown): {
  text: string;
  hasStructuredContent: boolean;
  structuredContent: unknown;
};
