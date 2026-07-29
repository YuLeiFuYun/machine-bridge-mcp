export const MCP_MODERN_PROTOCOL_VERSION: "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION: "2025-11-25";
export const MCP_MODERN_PROTOCOL_VERSIONS: readonly string[];
export const MCP_LEGACY_PROTOCOL_VERSIONS: readonly string[];
export const MCP_HEADER_MISMATCH: -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION: -32022;
export class McpProtocolError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown);
}
export function asMcpObject(value: unknown): Record<string, any>;
export function requestProtocolVersion(value: unknown): string;
export function isModernMcpRequest(value: unknown): boolean;
export function assertBoundedMcpJsonStructure(value: unknown, label?: string): void;
export function validateModernRequestMetadata(value: unknown, supportedVersions?: readonly string[]): {
  version: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo: Record<string, unknown> | null;
  progressToken: unknown;
  logLevel: unknown;
};
export function serverImplementation(input: { name: unknown; version: unknown; title?: unknown; description?: unknown }): Record<string, unknown>;
export function modernCompleteResult(fields?: Record<string, unknown>, serverInfo?: Record<string, unknown>): Record<string, unknown>;
export function modernCacheableResult(fields: Record<string, unknown>, options: { ttlMs: number; cacheScope: "public" | "private"; serverInfo?: Record<string, unknown> }): Record<string, unknown>;
export function modernDiscoverResult(input: { supportedVersions: readonly string[]; capabilities: Record<string, unknown>; instructions?: string; ttlMs?: number; serverInfo?: Record<string, unknown> }): Record<string, unknown>;
export function resultForProtocol(version: string, fields: Record<string, unknown>, options?: { serverInfo?: Record<string, unknown>; ttlMs?: number; cacheScope?: "public" | "private" }): Record<string, unknown>;
