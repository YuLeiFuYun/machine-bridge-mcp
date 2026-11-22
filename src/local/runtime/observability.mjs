import { performance } from "node:perf_hooks";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import { projectMcpResult } from "../../shared/result-projection.mjs";
import { completeResult } from "../../shared/mcp-protocol.mjs";

const DURATION_BUCKETS_MS = Object.freeze([100, 1000, 10_000, 30_000, 60_000]);

const MAX_TOOLS = 128;

const MAX_ERROR_CODES = 64;

const MAX_TOOL_METRICS = 32;

const DEFAULT_COST_CALL_THRESHOLD = 200;

const DEFAULT_COST_BYTE_THRESHOLD = 8 * 1024 * 1024;

const COST_WINDOW_MS = 60 * 60 * 1000;

const NON_WORK_ERROR_CODES = new Set(["policy_denied", "authorization_denied", "invalid_request"]);

export class RuntimeObservability {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.windowNow = typeof options.now === "function" ? options.now : () => performance.now();
    this.startedAt = this.now();
    this.windowStartedAt = this.windowNow();
    this.windowCalls = 0;
    this.windowResultBytes = 0;
    this.costCallThreshold = positiveThreshold(options.costCallThreshold, DEFAULT_COST_CALL_THRESHOLD);
    this.costByteThreshold = positiveThreshold(options.costByteThreshold, DEFAULT_COST_BYTE_THRESHOLD);
    this.calls = { started: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, slow: 0 };
    this.totalResultBytes = 0;
    this.taintAdvisories = 0;
    this.byTool = new Map();
    this.errors = new Map();
  }

  rotateCostWindowIfExpired() {
    const current = this.windowNow();
    if (current - this.windowStartedAt >= COST_WINDOW_MS || current < this.windowStartedAt) {
      this.windowStartedAt = current;
      this.windowCalls = 0;
      this.windowResultBytes = 0;
    }
  }

  start(tool) {
    this.calls.started += 1;
    const metric = this.toolMetric(tool);
    metric.started += 1;
    metric.active += 1;
  }

  recordTaintAdvisory() {
    this.taintAdvisories += 1;
  }

  finish(tool, { status, durationMs, errorCode = "", slow = false, resultBytes = 0 } = {}) {
    this.rotateCostWindowIfExpired();
    const metric = this.toolMetric(tool);
    metric.active = Math.max(0, metric.active - 1);
    metric.last_duration_ms = boundedDuration(durationMs);
    metric.max_duration_ms = Math.max(metric.max_duration_ms, metric.last_duration_ms);
    metric.total_duration_ms += metric.last_duration_ms;
    metric.duration_buckets[bucketName(metric.last_duration_ms)] += 1;
    const bytes = boundedDuration(resultBytes);
    metric.total_result_bytes += bytes;
    metric.max_result_bytes = Math.max(metric.max_result_bytes, bytes);
    this.totalResultBytes += bytes;
    if (status === "completed") {
      this.calls.completed += 1;
      metric.completed += 1;
      this.windowCalls += 1;
      this.windowResultBytes += bytes;
    } else {
      this.calls.failed += 1;
      metric.failed += 1;
      if (status === "cancelled") this.calls.cancelled += 1;
      if (status === "timeout") this.calls.timed_out += 1;
      if (errorCode) this.incrementError(errorCode);
      if (!NON_WORK_ERROR_CODES.has(errorCode)) {
        this.windowCalls += 1;
        this.windowResultBytes += bytes;
      }
    }
    if (slow) { this.calls.slow += 1; metric.slow += 1; }
  }

  snapshot() {
    this.rotateCostWindowIfExpired();
    const toolMetrics = [...this.byTool.entries()]
      .map(([name, metric]) => {
        const calls = metric.completed + metric.failed;
        return {
          tool: name,
          calls,
          errors: metric.failed,
          total_ms: metric.total_duration_ms,
          avg_ms: calls > 0 ? Math.round(metric.total_duration_ms / calls) : 0,
          max_result_bytes: metric.max_result_bytes,
        };
      })
      .sort((left, right) => right.total_ms - left.total_ms || right.calls - left.calls || left.tool.localeCompare(right.tool))
      .slice(0, MAX_TOOL_METRICS);
    const callsExceeded = this.windowCalls >= this.costCallThreshold;
    const bytesExceeded = this.windowResultBytes >= this.costByteThreshold;
    const costWarning = callsExceeded || bytesExceeded
      ? {
        active: true,
        reason: callsExceeded && bytesExceeded ? "call_and_byte_budget" : callsExceeded ? "call_count_budget" : "result_byte_budget",
        calls: this.windowCalls,
        total_result_bytes: this.windowResultBytes,
        window_ms: COST_WINDOW_MS,
      }
      : null;
    return {
      uptime_ms: Math.max(0, this.now() - this.startedAt),
      calls: { ...this.calls },
      active: [...this.byTool.values()].reduce((sum, metric) => sum + metric.active, 0),
      total_result_bytes: this.totalResultBytes,
      taint_advisories: this.taintAdvisories,
      errors: Object.fromEntries([...this.errors.entries()].sort(([a], [b]) => a.localeCompare(b))),
      tools: Object.fromEntries([...this.byTool.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, metric]) => [name, {
        ...metric,
        duration_buckets: { ...metric.duration_buckets },
      }])),
      tool_metrics: toolMetrics,
      cost_warning: costWarning,
    };
  }

  toolMetric(tool) {
    let name = String(tool || "unknown").slice(0, 128) || "unknown";
    if (!this.byTool.has(name) && this.byTool.size >= MAX_TOOLS - (this.byTool.has("<other>") ? 0 : 1)) name = "<other>";
    if (!this.byTool.has(name)) {
      this.byTool.set(name, {
        started: 0, completed: 0, failed: 0, active: 0, slow: 0,
        total_duration_ms: 0, max_duration_ms: 0, last_duration_ms: 0,
        total_result_bytes: 0, max_result_bytes: 0,
        duration_buckets: Object.fromEntries([...DURATION_BUCKETS_MS.map((value) => [`le_${value}`, 0]), ["gt_60000", 0]]),
      });
    }
    return this.byTool.get(name);
  }

  incrementError(code) {
    let key = String(code || "execution_failed").slice(0, 64);
    if (!this.errors.has(key) && this.errors.size >= MAX_ERROR_CODES - (this.errors.has("<other>") ? 0 : 1)) key = "<other>";
    this.errors.set(key, (this.errors.get(key) || 0) + 1);
  }
}

function positiveThreshold(value, fallback) {
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 1 ? num : fallback;
}

function bucketName(durationMs) {
  for (const threshold of DURATION_BUCKETS_MS) if (durationMs <= threshold) return `le_${threshold}`;
  return "gt_60000";
}

function boundedDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
}
export {
  POLICY_PROFILES,
  PolicyGate,
  allToolNames,
  assertCanonicalFullPolicy,
  isCanonicalFullPolicy,
  normalizePolicy,
  policyProfile,
  toolsForPolicy,
} from "../core/policy.mjs";

export const SERVER_NAME = String(serverMetadata.name);

export const TOOL_SCHEMA_GENERATION = Number(serverMetadata.toolSchemaGeneration);

export const MCP_PROTOCOL_VERSION = String(serverMetadata.protocolVersion);

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(serverMetadata.supportedProtocolVersions.map((value) => String(value)));

export const MCP_INSTRUCTIONS = Object.freeze(serverMetadata.instructions.map((value) => String(value))).join("\n");

export function toolResult(value, isError = false, serverInfo) {
  const special = specialMcpResult(value);
  if (special) return completeResult({ ...special, isError }, serverInfo);
  const projection = projectMcpResult(value);
  const result = { content: [{ type: "text", text: projection.text }], isError };
  if (projection.hasStructuredContent) result.structuredContent = structuredClone(projection.structuredContent);
  return completeResult(result, serverInfo);
}

export function rpcResult(id, result) {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function specialMcpResult(value) {
  const special = value && typeof value === "object" && !Array.isArray(value) ? value.$mcp : null;
  if (!special || typeof special !== "object" || !Array.isArray(special.content)) return null;
  const result = { content: structuredClone(special.content) };
  if (Object.prototype.hasOwnProperty.call(special, "structuredContent")) {
    result.structuredContent = structuredClone(special.structuredContent);
  }
  return result;
}
