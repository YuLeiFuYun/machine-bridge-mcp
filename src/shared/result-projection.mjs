// @ts-check

import resultProjection from "./result-projection.json" with { type: "json" };

export const MCP_TEXT_PROJECTION_KEY = "$mcpText";

/**
 * Keep MCP text content useful for human-only clients without duplicating a
 * large object that is already present in structuredContent.
 * @param {unknown} value
 */
export function mirroredResultText(value) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") return String(value ?? "");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= Number(resultProjection.maxMirroredJsonBytes)) return serialized;
  const object = asObject(value);
  const keys = Object.keys(object)
    .slice(0, Number(resultProjection.maximumSummaryKeys))
    .map((key) => key.replace(/[\r\n\t]+/g, " ").slice(0, 80));
  const fields = keys.length ? ` Fields: ${keys.join(", ")}.` : "";
  return `Structured result is ${bytes} bytes and is available in structuredContent.${fields}`;
}

/**
 * Extract an optional domain-provided text projection while keeping the
 * authoritative structured object single-copy and marker-free.
 * @param {unknown} value
 */
export function projectMcpResult(value) {
  const object = asObject(value);
  if (Object.prototype.hasOwnProperty.call(object, MCP_TEXT_PROJECTION_KEY)
      && typeof object[MCP_TEXT_PROJECTION_KEY] === "string") {
    const structuredContent = { ...object };
    const text = String(structuredContent[MCP_TEXT_PROJECTION_KEY]).slice(0, 4096);
    delete structuredContent[MCP_TEXT_PROJECTION_KEY];
    return { text, hasStructuredContent: true, structuredContent };
  }
  return {
    text: mirroredResultText(value),
    hasStructuredContent: isJsonValue(value),
    structuredContent: value,
  };
}

/** @param {unknown} value */
function isJsonValue(value) {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || Array.isArray(value)
    || (value && typeof value === "object");
}

/** @param {unknown} value */
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}
