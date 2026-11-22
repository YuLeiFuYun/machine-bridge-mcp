// @ts-check
import { isSuccessfulJobStatus, MCP_TASK_POLL_INTERVAL_MS, MCP_TASK_TTL_MS, statusMessageFor, taskStatusForJob } from "../../shared/mcp-task-contract.mjs";
import { completeResult } from "../../shared/mcp-protocol.mjs";
import { projectMcpResult } from "../../shared/result-projection.mjs";

/** @param {Record<string, unknown>} job @param {string} taskId */
export function taskViewForJob(job, taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) throw new Error("Task is missing its identifier");
  const status = taskStatusForJob(job);
  if (!status) throw new Error(`Task ${taskId} has an unknown execution state`);
  const createdAt = typeof job?.created_at === "string" ? job.created_at
    : typeof job?.createdAt === "string" ? job.createdAt : null;
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error(`Task ${taskId} is missing a valid creation timestamp`);
  const candidateUpdatedAt = typeof job?.updated_at === "string" ? job.updated_at
    : typeof job?.updatedAt === "string" ? job.updatedAt : createdAt;
  const lastUpdatedAt = Number.isFinite(Date.parse(candidateUpdatedAt)) ? candidateUpdatedAt : createdAt;
  return {
    taskId,
    status,
    statusMessage: statusMessageFor(job, status),
    createdAt,
    lastUpdatedAt,
    ttlMs: MCP_TASK_TTL_MS,
    pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS,
  };
}

/** @param {Record<string, unknown>} job @param {Record<string, unknown>} serverInfo */
export function taskToolResult(job, serverInfo) {
  const projection = projectMcpResult(job);
  /** @type {Record<string, unknown>} */
  const result = {
    content: [{ type: "text", text: projection.text }],
    isError: !isSuccessfulJobStatus(job),
  };
  if (projection.hasStructuredContent) result.structuredContent = structuredClone(projection.structuredContent);
  return completeResult(result, serverInfo);
}
const TUNNEL_INTERFACE = /^(?:utun|tun|tap|ppp|ipsec|wg|gif|stf)/i;

const LOOPBACK_INTERFACE = /^lo\d*$/i;

const PHYSICAL_INTERFACE = /^(?:en|eth|wlan|wl|wifi|wi-fi)\d*$/i;

/** @typedef {{code?: number, stdout?: string}} FixedProcessResult */
/** @typedef {(command: string, args: string[], timeoutMs: number, capture: boolean, maxOutputBytes: number, context: unknown) => Promise<FixedProcessResult>} FixedInternalRunner */
/**
 * @typedef {{
 *   platform?: string,
 *   runFixedInternal?: FixedInternalRunner,
 *   classifyError?: (error: unknown) => string,
 *   context?: unknown,
 * }} SystemNetworkRouteOptions
 */

/** @param {SystemNetworkRouteOptions} [options] */
export async function systemNetworkRouteCheck({
  platform = process.platform,
  runFixedInternal,
  classifyError = () => "unavailable",
  context = {},
} = {}) {
  try {
    const route = await inspectSystemNetworkRoute({ platform, runFixedInternal, context });
    return route.supported && route.available ? {
      layer: "system-network-route",
      ok: true,
      route_class: route.route_class,
      operating_system_interception: route.operating_system_interception === true,
    } : {
      layer: "system-network-route",
      ok: false,
      skipped: true,
      error_class: route.supported ? "unavailable" : "unsupported_platform",
    };
  } catch (error) {
    return {
      layer: "system-network-route",
      ok: false,
      skipped: true,
      error_class: classifyError(error),
    };
  }
}

/** @param {SystemNetworkRouteOptions} [options] */
export async function inspectSystemNetworkRoute({
  platform = process.platform,
  runFixedInternal,
  context = {},
} = {}) {
  if (platform !== "darwin" || typeof runFixedInternal !== "function") return { supported: false };
  const result = await runFixedInternal("/sbin/route", ["-n", "get", "default"], 5_000, true, 16 * 1024, context);
  if (result?.code !== 0) return { supported: true, available: false };
  const match = String(result.stdout || "").match(/^\s*interface:\s*(\S+)\s*$/mi);
  if (!match) return { supported: true, available: false };
  const routeClass = classifySystemRouteInterface(match[1]);
  return {
    supported: true,
    available: true,
    route_class: routeClass,
    operating_system_interception: routeClass === "tunnel-or-vpn",
  };
}

/** @param {unknown} value */
export function classifySystemRouteInterface(value) {
  const name = String(value || "").trim();
  if (!name) return "unknown";
  if (TUNNEL_INTERFACE.test(name)) return "tunnel-or-vpn";
  if (LOOPBACK_INTERFACE.test(name)) return "loopback";
  if (PHYSICAL_INTERFACE.test(name)) return "physical-or-other";
  return "other";
}
