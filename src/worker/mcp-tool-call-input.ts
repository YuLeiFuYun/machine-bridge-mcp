import { validateWorkerToolArguments } from "./tool-catalog.ts";
import { asObject } from "./mcp-jsonrpc.ts";

type ToolDefinition = Readonly<{ name?: unknown }>;
type ValidationIssue = Readonly<{ instancePath: string; keyword: string; message: string }>;

export type WorkerToolCallInput =
  | Readonly<{ ok: true; name: string; args: Record<string, unknown> }>
  | Readonly<{ ok: false; reason: "missing_name" | "unknown_tool" | "invalid_arguments"; issues?: readonly ValidationIssue[] }>;

export function inspectWorkerToolCall(paramsValue: unknown, advertisedTools: readonly ToolDefinition[]): WorkerToolCallInput {
  const params = asObject(paramsValue);
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "";
  if (!name) return Object.freeze({ ok: false, reason: "missing_name" });
  if (!advertisedTools.some((tool) => tool.name === name)) return Object.freeze({ ok: false, reason: "unknown_tool" });
  const rawArgs = params.arguments === undefined ? {} : params.arguments;
  const validation = validateWorkerToolArguments(name, rawArgs);
  if (!validation.known) return Object.freeze({ ok: false, reason: "unknown_tool" });
  if (!validation.valid) {
    return Object.freeze({ ok: false, reason: "invalid_arguments", issues: validation.issues });
  }
  return Object.freeze({ ok: true, name, args: rawArgs as Record<string, unknown> });
}
