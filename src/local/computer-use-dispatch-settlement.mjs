import { errorCode } from "./errors.mjs";

const UNKNOWN_MUTATION_ERROR_PREFIXES = Object.freeze([
  "browser mutation request may have been dispatched;",
  "browser mutation may have completed;",
  "browser action may have been dispatched;",
  "trusted browser input may have been partially dispatched;",
  "browser tab mutation may have been dispatched;",
  "browser screenshot temporary tab activation may have been dispatched;",
  "browser screenshot restoration may have been dispatched;",
  "application visual input may have been partially dispatched;",
  "application launch may have been partially dispatched;",
  "application accessibility mutation may have been partially dispatched;",
  "application activation may have been partially dispatched;",
  "application checked-state input may have been partially dispatched;",
  "application accessibility input may have been partially dispatched;",
  "application value input may have been partially dispatched;",
  "application keystroke may have been partially dispatched;",
  "application key_press may have been partially dispatched;",
]);

export async function settleComputerUseDispatch(surface, dispatch) {
  try {
    return { dispatchStatus: "completed", dispatchResult: await dispatch(), dispatchError: "" };
  } catch (error) {
    if (!isUnknownOutcomeError(error)) throw error;
    return { dispatchStatus: "unknown", dispatchResult: null, dispatchError: publicUnknownOutcomeError(surface, error) };
  }
}

function isUnknownOutcomeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return UNKNOWN_MUTATION_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function publicUnknownOutcomeError(surface, error) {
  const normalizedSurface = surface === "application" ? "application" : "browser";
  const inspection = normalizedSurface === "application" ? "Inspect the application" : "Inspect browser state";
  return `${normalizedSurface} mutation may have been dispatched; the outcome is unknown. ${inspection} before retrying. (error_class=${errorCode(error)})`;
}
