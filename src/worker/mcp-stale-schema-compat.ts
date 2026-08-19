import { isRemoteDurableProcessTool } from "./tool-timeout.ts";
import { rpcResult, textToolResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";

type ValidationIssue = Readonly<{ instancePath: string; keyword: string; message: string }>;

export function staleSchemaCompatibilityResult(
  request: JsonRpcRequest,
  issues: readonly ValidationIssue[] | undefined,
  serverInfo: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!issues?.length) return null;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : null;
  const toolName = typeof params?.name === "string" ? params.name : "";
  if (missingDurableRecoveryKey(toolName, issues)) {
    return rpcResult(request.id, textToolResult({
      error: {
        code: "invalid_request",
        message: "cached tool schema is missing the required durable-process idempotency_key; refresh tools/list and retry with one unique key for this intended execution, reusing that same key only when recovering an ambiguous acceptance response",
        retryable: false,
        details: {
          side_effects_started: false,
          schema_refresh_recommended: true,
          recovery_credential_required: "idempotency_key",
          validation_issues: [...issues],
        },
      },
    }, true, serverInfo));
  }
  if (!compatibleMaximum(toolName, issues)) return null;
  return rpcResult(request.id, textToolResult({
    error: {
      code: "invalid_request",
      message: toolName === "read_process"
        ? "cached read_process arguments exceed the current server limit; refresh tools/list, use read_process at most once for a live session in the current hosted assistant response, and return progress whenever running=true even if output was returned; use run_process/read_job for non-interactive durable work"
        : "cached tool arguments exceed the current server limit; refresh tools/list and use request-bounded execution or durable jobs instead of holding one response open",
      retryable: false,
      details: {
        side_effects_started: false,
        schema_refresh_recommended: true,
        validation_issues: [...issues],
      },
    },
  }, true, serverInfo));
}

function missingDurableRecoveryKey(toolName: string, issues: readonly ValidationIssue[]): boolean {
  return isRemoteDurableProcessTool(toolName)
    && issues.every((issue) => issue.instancePath === ""
      && issue.keyword === "required"
      && issue.message === "missing required property idempotency_key");
}

function compatibleMaximum(toolName: string, issues: readonly ValidationIssue[]): boolean {
  if (issues.some((issue) => issue.keyword !== "maximum")) return false;
  return issues.every((issue) => issue.instancePath === "/timeout_seconds")
    || toolName === "read_process" && issues.every((issue) => issue.instancePath === "/wait_ms");
}
