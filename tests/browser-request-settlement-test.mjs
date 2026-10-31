import assert from "node:assert/strict";
import {
  browserRequestResponseError,
  browserRequestTransportError,
  invalidBrowserResponseSettlement,
} from "../src/local/browser-request-settlement.mjs";

const mutation = { method: "action", dispatchAttempted: true };
const readOnly = { method: "inspect_page", dispatchAttempted: true };
const unsentMutation = { method: "action", dispatchAttempted: false };

const postDispatch = browserRequestTransportError({ pending: mutation, code: "unavailable", fallback: new Error("socket gone") });
assert.equal(postDispatch.code, "unavailable");
assert.equal(postDispatch.retryable, false);
assert.match(postDispatch.message, /outcome is unknown/);
assert.deepEqual(postDispatch.details, {
  request_delivery: "sent", side_effects_started: "unknown", termination_requested: false, effect_settlement: "unknown",
});

const terminated = browserRequestTransportError({
  pending: mutation, code: "timeout", fallback: "timed out", terminationRequested: true,
});
assert.equal(terminated.code, "timeout");
assert.equal(terminated.retryable, false);
assert.equal(terminated.details.termination_requested, true);
assert.equal(terminated.details.effect_settlement, "pending");

const readFailure = browserRequestTransportError({ pending: readOnly, code: "unavailable", fallback: new Error("read transport failed") });
assert.equal(readFailure.message, "read transport failed");
assert.equal(readFailure.retryable, true);
assert.equal(readFailure.details, undefined);
assert.equal(browserRequestTransportError({ pending: readOnly, code: "cancelled", fallback: "cancelled" }).retryable, false);
assert.equal(browserRequestTransportError({ pending: null, code: "unavailable", fallback: {} }).message, "browser transport failed");
assert.equal(browserRequestTransportError({ pending: unsentMutation, code: "unavailable", fallback: "" }).message, "browser transport failed");

const busy = browserRequestResponseError("browser broker is busy", mutation);
assert.equal(busy.code, "limit_exceeded");
assert.equal(busy.retryable, true);
for (const message of ["browser extension is not connected", "browser extension send failed"]) {
  const error = browserRequestResponseError(message, mutation);
  assert.equal(error.code, "unavailable");
  assert.equal(error.retryable, true);
}

const uncertain = browserRequestResponseError("browser mutation request may have been dispatched; response lost", mutation);
assert.equal(uncertain.code, "unavailable");
assert.equal(uncertain.retryable, false);
assert.equal(uncertain.details.request_delivery, "sent");

const timeout = browserRequestResponseError("browser broker request timed out after dispatch; cancellation requested", mutation);
assert.equal(timeout.code, "timeout");
assert.equal(timeout.details.termination_requested, true);
assert.equal(timeout.details.effect_settlement, "pending");
const readTimeout = browserRequestResponseError("browser broker request timed out after dispatch", readOnly);
assert.equal(readTimeout.code, "timeout");
assert.equal(readTimeout.retryable, true);
assert.equal(readTimeout.details, undefined);

const changed = browserRequestResponseError("browser connection changed after request dispatch", mutation);
assert.equal(changed.code, "unavailable");
assert.equal(changed.retryable, false);

for (const message of [
  "browser mutation may have completed; the action outcome is unknown because its result could not be delivered",
  "trusted browser input may have been partially dispatched",
  "form submission failed after partial changes",
  "browser action may have been dispatched",
  "browser tab mutation may have been dispatched",
  "browser screenshot temporary tab activation may have been dispatched",
  "browser screenshot restoration may have been dispatched",
]) {
  const error = browserRequestResponseError(message, mutation);
  assert.equal(error.code, "execution_failed");
  assert.equal(error.retryable, false);
  assert.equal(error.details.side_effects_started, true);
  assert.equal(error.details.effect_settlement, "unknown");
}

const readPartial = browserRequestResponseError("browser action may have been dispatched", readOnly);
assert.equal(readPartial.code, "execution_failed");
assert.equal(readPartial.details, undefined);
const ordinary = browserRequestResponseError("ordinary browser failure", mutation);
assert.equal(ordinary.code, "execution_failed");
assert.equal(ordinary.details, undefined);

// Structured settlement from the extension is authoritative; the text table is only a
// fallback for extensions that predate the field.
const typedUnknown = browserRequestResponseError("browser result could not be serialized", mutation, { settlement: "unknown" });
assert.equal(typedUnknown.code, "execution_failed");
assert.equal(typedUnknown.retryable, false);
assert.equal(typedUnknown.details.side_effects_started, true);
assert.equal(typedUnknown.details.effect_settlement, "unknown");
const typedNotStarted = browserRequestResponseError("browser action may have been dispatched", mutation, { settlement: "not_started" });
assert.equal(typedNotStarted.details, undefined, "an explicit not_started settlement did not override the legacy text heuristic");
const typedReadOnly = browserRequestResponseError("browser result could not be serialized", readOnly, { settlement: "unknown" });
assert.equal(typedReadOnly.details, undefined, "a read-only request claimed side effects from an unknown settlement");
const typedApplied = browserRequestResponseError("browser action reported success after the response was lost", mutation, { settlement: "applied" });
assert.equal(typedApplied.code, "execution_failed");
assert.equal(typedApplied.retryable, false);
assert.equal(typedApplied.details.side_effects_started, true);
assert.equal(typedApplied.details.effect_settlement, "applied",
  "a declared applied settlement was flattened into an anonymous failure");
const unknownEnvelopeValue = browserRequestResponseError("browser result could not be serialized", mutation, { settlement: "not-a-real-value" });
assert.equal(unknownEnvelopeValue.details, undefined, "an unrecognised settlement value was treated as a partial mutation");

const malformedMutation = invalidBrowserResponseSettlement(mutation);
assert.equal(malformedMutation.code, "execution_failed");
assert.equal(malformedMutation.retryable, false);
assert.equal(malformedMutation.details.request_delivery, "sent");
const malformedRead = invalidBrowserResponseSettlement(readOnly);
assert.equal(malformedRead.code, "execution_failed");
assert.equal(malformedRead.details, undefined);

console.log("browser request settlement test ok");
