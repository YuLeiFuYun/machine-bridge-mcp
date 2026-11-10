// @ts-check
export const DOCTOR_RUNTIME_SCOPE = Object.freeze({
  running_service_process_inspected: false,
  remote_relay_inspected: false,
  reason: "doctor uses an isolated local runtime; inspect authenticated server_info.daemon.relay_transport for the running service relay",
});

/**
 * @param {Record<string, any>} [check]
 * @returns {{ name: string, ok: boolean, applicable: boolean, detail: string }}
 */
export function doctorRuntimeCheckProjection(check = {}) {
  const layer = String(check.layer || "unknown");
  const skipped = check.skipped === true;
  const detail = skipped && layer === "remote-relay"
    ? "not inspected (doctor uses an isolated local runtime; inspect authenticated server_info.daemon.relay_transport)"
    : skipped
      ? `skipped (${check.error_class || "not applicable"})`
      : check.ok === true
        ? "ok"
        : String(check.error_class || "failed");
  return {
    name: `runtime:${layer}`,
    ok: skipped || check.ok === true,
    applicable: !skipped,
    detail,
  };
}
