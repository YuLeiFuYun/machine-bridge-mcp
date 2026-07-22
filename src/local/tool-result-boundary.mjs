import { Buffer } from "node:buffer";
import { BridgeError } from "./errors.mjs";

export const MAX_TOOL_RESULT_BYTES = 7 * 1024 * 1024;

export function normalizeToolResult(value, options = {}) {
  const maximumBytes = positiveInteger(options.maximumBytes, MAX_TOOL_RESULT_BYTES);
  let serialized;
  try {
    serialized = JSON.stringify(value, rejectUnsupportedJsonValue);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("internal_error", "tool returned a result that could not be serialized", {
      cause: error instanceof Error ? error : undefined,
      expose: false,
    });
  }
  if (typeof serialized !== "string") {
    throw new BridgeError("internal_error", "tool returned an unsupported result", { expose: false });
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumBytes) {
    throw new BridgeError("limit_exceeded", "tool result exceeded the relay response limit", {
      retryable: false,
      details: { maximum_bytes: maximumBytes, actual_bytes: bytes },
    });
  }
  try {
    return Object.freeze({ value: JSON.parse(serialized), bytes });
  } catch (error) {
    throw new BridgeError("internal_error", "tool result normalization failed", {
      cause: error instanceof Error ? error : undefined,
      expose: false,
    });
  }
}

function rejectUnsupportedJsonValue(_key, current) {
  if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol" || typeof current === "undefined") {
    throw new BridgeError("internal_error", "tool returned a non-JSON value", { expose: false });
  }
  if (typeof current === "number" && !Number.isFinite(current)) {
    throw new BridgeError("internal_error", "tool returned a non-finite number", { expose: false });
  }
  return current;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
