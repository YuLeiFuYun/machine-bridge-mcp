// @ts-check

/** @type {Readonly<Record<string, string>>} */
const DETAIL_BY_REASON = Object.freeze({
  relay_authentication_failed: "candidate relay authentication failed after readiness",
  autostart_install_failed: "candidate autostart installation failed after readiness",
  autostart_start_failed: "candidate autostart start failed after readiness",
});

/** @param {unknown} value */
export function isActivationRecoveryReason(value) {
  return typeof value === "string" && Object.hasOwn(DETAIL_BY_REASON, value);
}

/** @param {unknown} reason */
export function canonicalActivationRecoveryDetail(reason) {
  if (typeof reason !== "string") throw new Error("activation recovery reason is invalid");
  const detail = DETAIL_BY_REASON[reason];
  if (!detail) throw new Error("activation recovery reason is invalid");
  return detail;
}

/**
 * Normalize recovered-activation metadata without retaining lower-layer error text.
 * `detail` is still validated so historical schema-2 records fail closed when their
 * bounded shape is corrupt, but every accepted record/result projects the fixed
 * reason-owned detail instead of replaying the stored text.
 * @param {{recovered: unknown, reason?: unknown, detail?: unknown}} value
 */
export function normalizeActivationRecovery(value) {
  if (typeof value.recovered !== "boolean") throw new Error("activation recovery flag is invalid");
  const reason = value.reason === null || value.reason === undefined ? "" : value.reason;
  const detail = value.detail === null || value.detail === undefined ? "" : value.detail;
  if (!value.recovered) {
    if (reason || detail) throw new Error("activation recovery metadata is inconsistent");
    return Object.freeze({ recovered: false, reason: "", detail: "" });
  }
  if (typeof reason !== "string") throw new Error("activation recovery reason is invalid");
  if (typeof detail !== "string") throw new Error("activation recovery detail is invalid");
  if (!isActivationRecoveryReason(reason)) throw new Error("activation recovery reason is invalid");
  if (!detail || detail.length > 600 || /[\r\n\t]/.test(detail)) {
    throw new Error("activation recovery detail is invalid");
  }
  return Object.freeze({
    recovered: true,
    reason,
    detail: canonicalActivationRecoveryDetail(reason),
  });
}
