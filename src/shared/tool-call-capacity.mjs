export const CONTROL_PLANE_TOOL_NAMES = Object.freeze([
  "diagnose_runtime",
  "list_roots",
]);

export function toolCallCapacityConfig(maximumValue, reservedValue, reservedTools = CONTROL_PLANE_TOOL_NAMES) {
  const maximum = positiveInteger(maximumValue, 1);
  const reserved = Math.min(nonNegativeInteger(reservedValue, 0), Math.max(0, maximum - 1));
  return Object.freeze({
    maximum,
    reserved,
    ordinaryMaximum: maximum - reserved,
    reservedTools: new Set(Array.from(reservedTools, (value) => String(value))),
  });
}

export function toolCallCapacityUsage(snapshot, config) {
  const active = nonNegativeInteger(snapshot?.active, 0);
  const byTool = plainRecord(snapshot?.byTool) ? snapshot.byTool : {};
  let activeReserved = 0;
  for (const [tool, rawCount] of Object.entries(byTool)) {
    if (config.reservedTools.has(tool)) activeReserved += nonNegativeInteger(rawCount, 0);
  }
  activeReserved = Math.min(active, activeReserved);
  return Object.freeze({
    active,
    activeReserved,
    activeOrdinary: active - activeReserved,
    maximum: config.maximum,
    ordinaryMaximum: config.ordinaryMaximum,
    reserved: config.reserved,
  });
}

export function toolCallAdmission(snapshot, config, toolName) {
  const usage = toolCallCapacityUsage(snapshot, config);
  if (usage.active >= config.maximum) return Object.freeze({ allowed: false, reason: "total_capacity", ...usage });
  if (config.reserved <= 0 || config.reservedTools.has(String(toolName || ""))) {
    return Object.freeze({ allowed: true, reason: "admitted", ...usage });
  }
  if (usage.activeOrdinary >= config.ordinaryMaximum) {
    return Object.freeze({ allowed: false, reason: "ordinary_capacity", ...usage });
  }
  return Object.freeze({ allowed: true, reason: "admitted", ...usage });
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
