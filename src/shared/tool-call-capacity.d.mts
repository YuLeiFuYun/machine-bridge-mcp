export type ToolCallCapacityConfig = Readonly<{
  maximum: number;
  reserved: number;
  ordinaryMaximum: number;
  reservedTools: ReadonlySet<string>;
}>;

export type ToolCallCapacitySnapshot = {
  active?: unknown;
  byTool?: Record<string, unknown>;
};

export type ToolCallCapacityUsage = Readonly<{
  active: number;
  activeReserved: number;
  activeOrdinary: number;
  maximum: number;
  ordinaryMaximum: number;
  reserved: number;
}>;

export type ToolCallAdmission = ToolCallCapacityUsage & Readonly<{
  allowed: boolean;
  reason: "admitted" | "total_capacity" | "ordinary_capacity";
}>;

export const CONTROL_PLANE_TOOL_NAMES: readonly string[];
export function toolCallCapacityConfig(
  maximumValue: unknown,
  reservedValue: unknown,
  reservedTools?: Iterable<string>,
): ToolCallCapacityConfig;
export function toolCallCapacityUsage(
  snapshot: ToolCallCapacitySnapshot,
  config: ToolCallCapacityConfig,
): ToolCallCapacityUsage;
export function toolCallAdmission(
  snapshot: ToolCallCapacitySnapshot,
  config: ToolCallCapacityConfig,
  toolName: unknown,
): ToolCallAdmission;
