import { isRemoteDurableProcessTool } from "./tool-timeout.ts";
import { rpcResult, textToolResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";

type ValidationIssue = Readonly<{ instancePath: string; keyword: string; message: string }>;
const HOSTED_EXPLICIT_TAB_TOOLS = new Set([
  "browser_get_source", "browser_inspect_page", "browser_wait", "browser_action",
  "browser_fill_form", "browser_screenshot", "browser_upload_files", "computer_observe",
]);

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
  const managedJobCredential = missingManagedJobCapability(toolName, issues);
  if (managedJobCredential) {
    return rpcResult(request.id, textToolResult({
      error: {
        code: "invalid_request",
        message: `cached tool schema is missing the required hosted managed-job ${managedJobCredential}; refresh tools/list because a job_id alone is not remote managed-job authority. If a pre-upgrade job never delivered this capability, use local CLI/stdio administration rather than global hosted discovery`,
        retryable: false,
        details: {
          side_effects_started: false,
          schema_refresh_recommended: true,
          recovery_credential_required: managedJobCredential,
          validation_issues: [...issues],
        },
      },
    }, true, serverInfo));
  }
  const hostedRequiredField = missingHostedRequiredField(toolName, issues);
  if (hostedRequiredField) {
    return rpcResult(request.id, textToolResult({
      error: {
        code: "invalid_request",
        message: hostedRequiredField === "dependency_recovery"
          ? "cached managed-job schema is missing hosted dependency recovery authority; refresh tools/list and provide dependency_recovery for every depends_on job using that upstream job's recovery_key"
          : "cached browser schema is missing the hosted explicit tab target; refresh tools/list, obtain the intended tab_id from browser_list_tabs, and retry without relying on shared active-tab focus",
        retryable: false,
        details: {
          side_effects_started: false,
          schema_refresh_recommended: true,
          required_field: hostedRequiredField,
          validation_issues: [...issues],
        },
      },
    }, true, serverInfo));
  }
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
        ? "cached read_process arguments exceed the current server limit; refresh tools/list, keep each remote blocking wait within the current one-second limit, let the daemon pace repeated would-block reads inside the same MCP call through next_blocking_poll_after_ms/cooldown state instead of rapid retrying, and use run_process/read_job for non-interactive durable work"
        : toolName === "read_job"
          ? "cached read_job arguments exceed the current hosted wait limit; refresh tools/list and continue the same durable job through bounded server-paced read_job calls instead of one overlong host request"
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

function missingManagedJobCapability(toolName: string, issues: readonly ValidationIssue[]): "recovery_key" | "control_key" | null {
  const expected = toolName === "read_job" ? "recovery_key" : toolName === "cancel_job" ? "control_key" : null;
  if (!expected) return null;
  const missing = (issue: ValidationIssue) => issue.instancePath === ""
    && issue.keyword === "required"
    && issue.message === `missing required property ${expected}`;
  if (!issues.some(missing)) return null;
  const knownStaleCompanion = (issue: ValidationIssue) => toolName === "read_job"
    && issue.instancePath === "/wait_ms" && issue.keyword === "maximum";
  return issues.every((issue) => missing(issue) || knownStaleCompanion(issue)) ? expected : null;
}

function missingHostedRequiredField(toolName: string, issues: readonly ValidationIssue[]): "dependency_recovery" | "tab_id" | null {
  const dependencyTool = toolName === "stage_job" || toolName === "start_job";
  const browserTool = HOSTED_EXPLICIT_TAB_TOOLS.has(toolName);
  const expected = dependencyTool ? "dependency_recovery" : browserTool ? "tab_id" : null;
  if (!expected) return null;
  return issues.every((issue) => issue.instancePath === ""
    && issue.keyword === "required"
    && issue.message === `missing required property ${expected}`) ? expected : null;
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
    || (toolName === "read_process" || toolName === "read_job")
      && issues.every((issue) => issue.instancePath === "/wait_ms");
}
