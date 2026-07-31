import {
  CONTROL_PLANE_TOOL_NAMES,
  toolCallAdmission,
  toolCallCapacityConfig,
  toolCallCapacityUsage,
  type ToolCallAdmission,
  type ToolCallCapacityConfig,
} from "../shared/tool-call-capacity.mjs";
import { WorkerToolError } from "./errors.ts";
import type { PendingCallRecord } from "./pending-call-contract.ts";

export { CONTROL_PLANE_TOOL_NAMES };

export const MAX_PENDING_CALLS = 32;
export const RESERVED_CONTROL_PENDING_CALLS = 2;
export const WORKER_PENDING_CALL_CAPACITY = toolCallCapacityConfig(
  MAX_PENDING_CALLS,
  RESERVED_CONTROL_PENDING_CALLS,
  CONTROL_PLANE_TOOL_NAMES,
);
export const WORKER_PENDING_REGISTRY_OPTIONS = Object.freeze({
  reservedCapacity: RESERVED_CONTROL_PENDING_CALLS,
  reservedTools: CONTROL_PLANE_TOOL_NAMES,
});


export type PendingRegistrySnapshot = PendingCapacitySnapshot & {
  detached: number;
  request_keys: number;
  maximum: number;
  ordinary_capacity: number;
  reserved_capacity: number;
  active_reserved: number;
  active_ordinary: number;
  oldest_ms: number;
};

export function pendingRegistrySnapshot(
  records: Iterable<PendingCallRecord>,
  requestKeyCount: number,
  now: number,
  config: ToolCallCapacityConfig,
): PendingRegistrySnapshot {
  const byTool = Object.create(null) as Record<string, number>;
  let active = 0;
  let detached = 0;
  let oldestMs = 0;
  for (const record of records) {
    active += 1;
    byTool[record.tool] = (byTool[record.tool] ?? 0) + 1;
    detached += Number(!record.socket);
    oldestMs = Math.max(oldestMs, now - record.startedAt);
  }
  const usage = toolCallCapacityUsage({ active, byTool }, config);
  return {
    active,
    detached,
    request_keys: requestKeyCount,
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_capacity: usage.reserved,
    active_reserved: usage.activeReserved,
    active_ordinary: usage.activeOrdinary,
    oldest_ms: oldestMs,
    by_tool: byTool,
  };
}

export type PendingCapacitySnapshot = {
  active: number;
  by_tool: Record<string, number>;
};

export function combinedPendingCapacity(
  transient: PendingCapacitySnapshot,
  durable: PendingCapacitySnapshot,
  config: ToolCallCapacityConfig = WORKER_PENDING_CALL_CAPACITY,
): {
  active: number;
  by_tool: Record<string, number>;
  maximum: number;
  ordinary_capacity: number;
  reserved_capacity: number;
  active_reserved: number;
  active_ordinary: number;
} {
  const byTool = Object.assign(Object.create(null) as Record<string, number>, transient.by_tool);
  for (const [tool, count] of Object.entries(durable.by_tool)) byTool[tool] = (byTool[tool] ?? 0) + count;
  const usage = toolCallCapacityUsage({ active: transient.active + durable.active, byTool }, config);
  return {
    active: usage.active,
    by_tool: byTool,
    maximum: usage.maximum,
    ordinary_capacity: usage.ordinaryMaximum,
    reserved_capacity: usage.reserved,
    active_reserved: usage.activeReserved,
    active_ordinary: usage.activeOrdinary,
  };
}

export function pendingCallAdmission(
  transient: PendingCapacitySnapshot,
  durable: PendingCapacitySnapshot,
  tool: string,
  config: ToolCallCapacityConfig = WORKER_PENDING_CALL_CAPACITY,
): ToolCallAdmission {
  const combined = combinedPendingCapacity(transient, durable, config);
  return toolCallAdmission({ active: combined.active, byTool: combined.by_tool }, config, tool);
}

export function assertWorkerPendingCallAdmission(
  transient: PendingCapacitySnapshot,
  durable: PendingCapacitySnapshot,
  tool: string,
): void {
  const decision = pendingCallAdmission(transient, durable, tool);
  if (decision.allowed) return;
  const message = decision.reason === "ordinary_capacity"
    ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
    : "too many concurrent daemon tool calls";
  throw new WorkerToolError("limit_exceeded", message, true);
}
