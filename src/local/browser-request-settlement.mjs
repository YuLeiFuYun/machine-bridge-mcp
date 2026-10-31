// @ts-check
import { browserMethodMayMutate, browserPostDispatchTransportFailure } from "./browser-extension-protocol.mjs";
import { BridgeError } from "./errors.mjs";
/** @typedef {{method: unknown, dispatchAttempted?: boolean}} BrowserPendingSettlement */
/** @param {{pending?: BrowserPendingSettlement | null, code: string, fallback: unknown, terminationRequested?: boolean}} options */
export function browserRequestTransportError({ pending, code, fallback, terminationRequested = false }) {
  const mutation = pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method);
  const message = mutation
    ? browserPostDispatchTransportFailure(pending.method, boundedMessage(fallback))
    : boundedMessage(fallback);
  return new BridgeError(code, message, {
    expose: true,
    retryable: mutation ? false : code !== "cancelled",
    ...(mutation ? {
      details: {
        request_delivery: "sent",
        side_effects_started: "unknown",
        termination_requested: terminationRequested === true,
        effect_settlement: terminationRequested === true ? "pending" : "unknown",
      },
    } : {}),
  });
}
// Messages the extension uses when a mutation may already have taken effect. Kept as a
// fallback for extensions that predate the structured `settlement` field; new extensions
// send `settlement: "unknown"` and never rely on this table.
const MUTATION_PARTIAL_PREFIXES = Object.freeze([
  "browser mutation may have completed;",
  "trusted browser input may have been partially dispatched",
  "form submission failed after partial changes",
  "browser action may have been dispatched",
  "browser tab mutation may have been dispatched",
  "browser screenshot temporary tab activation may have been dispatched",
  "browser screenshot restoration may have been dispatched",
]);
/** @param {string} message */
function textClaimsPartialMutation(message) {
  return MUTATION_PARTIAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}
/**
 * @param {string} message
 * @param {BrowserPendingSettlement | null | undefined} pending
 * @param {{settlement?: unknown} | null} [envelope] structured response from the extension
 */
export function browserRequestResponseError(message, pending, envelope = null) {
  const mutation = pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method);
  if (message === "browser broker is busy") return new BridgeError("limit_exceeded", message, { retryable: true });
  if (["browser extension is not connected", "browser extension send failed"].includes(message)) return new BridgeError("unavailable", message, { retryable: true });
  if (message.startsWith("browser mutation request may have been dispatched;")) {
    return browserRequestTransportError({ pending, code: "unavailable", fallback: message });
  }
  if (message.startsWith("browser broker request timed out after dispatch")) {
    return browserRequestTransportError({
      pending,
      code: "timeout",
      fallback: message,
      terminationRequested: mutation && message.includes("cancellation requested"),
    });
  }
  if (message.startsWith("browser connection changed after request dispatch")) {
    return browserRequestTransportError({ pending, code: "unavailable", fallback: message });
  }
  const declared = typeof envelope?.settlement === "string" ? envelope.settlement : "";
  if (declared === "applied") {
    // The extension is telling us the mutation landed; say so instead of returning a bare
    // failure that a caller might retry.
    return new BridgeError("execution_failed", message, {
      expose: true,
      retryable: false,
      details: { side_effects_started: true, termination_requested: false, effect_settlement: "applied" },
    });
  }
  const partial = mutation && (
    declared === "unknown"
    || (declared !== "not_started" && textClaimsPartialMutation(message))
  );
  return partial
    ? new BridgeError("execution_failed", message, {
        expose: true,
        retryable: false,
        details: { side_effects_started: true, termination_requested: false, effect_settlement: "unknown" },
      })
    : new BridgeError("execution_failed", message, { expose: true, retryable: false });
}
/** @param {BrowserPendingSettlement | null | undefined} pending */
export function invalidBrowserResponseSettlement(pending) {
  if (pending?.dispatchAttempted === true && browserMethodMayMutate(pending.method)) {
    return browserRequestTransportError({
      pending,
      code: "execution_failed",
      fallback: "browser extension response was malformed",
    });
  }
  return new BridgeError("execution_failed", "browser extension response was malformed", {
    expose: true,
    retryable: false,
  });
}
/** @param {unknown} value */
function boundedMessage(value) {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "browser transport failed";
  return message ? message.slice(0, 2000) : "browser transport failed";
}
