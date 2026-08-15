export const MCP_PROTOCOL_VERSION: "2026-07-28";
export const MCP_PROTOCOL_VERSIONS: readonly string[];
export const MCP_HEADER_MISMATCH: -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION: -32022;
export const MCP_REMOVED_PROTOCOL_MESSAGE: "MCP session protocol was removed; upgrade the client and use request-scoped metadata/server/discover";
export class McpProtocolError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown);
}
export function asMcpObject(value: unknown): Record<string, unknown>;
export function requestProtocolVersion(value: unknown): string;
export function assertBoundedMcpJsonStructure(value: unknown, label?: string): void;
export function validateRequestMetadata(value: unknown, supportedVersions?: readonly string[]): {
  version: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo: Record<string, unknown> | null;
  progressToken: unknown;
  logLevel: unknown;
};
export function serverImplementation(input: { name: unknown; version: unknown; title?: unknown; description?: unknown }): Record<string, unknown>;
export function completeResult(fields?: Record<string, unknown>, serverInfo?: Record<string, unknown>): Record<string, unknown>;
export function cacheableResult(fields: Record<string, unknown>, options: { ttlMs: number; cacheScope: "public" | "private"; serverInfo?: Record<string, unknown> }): Record<string, unknown>;
export function discoverResult(input: { supportedVersions: readonly string[]; capabilities: Record<string, unknown>; instructions?: string; ttlMs?: number; serverInfo?: Record<string, unknown> }): Record<string, unknown>;
export function validateSubscriptionRequest(value: unknown): void;
export function emptySubscriptionAcknowledgement(requestId: string | number): Record<string, unknown>;
export function subscriptionCompleteResult(requestId: string | number, serverInfo?: Record<string, unknown>): Record<string, unknown>;
