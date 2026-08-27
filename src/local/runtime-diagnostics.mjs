import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyOperationalError } from "./log.mjs";
import { readBoundedFile } from "./workspace-file-service.mjs";
import { systemNetworkRouteCheck } from "./system-network-route.mjs";
import { diagnosticControlPlaneState } from "./runtime-diagnostic-state.mjs";
import { resourceAdmissionDiagnostic } from "./resource-admission-diagnostics.mjs";
import { diagnosticActivityProjection, diagnosticInterpretation } from "./runtime-diagnostic-projection.mjs";
import { correlateEventLoopStallWithSystemSleep, correlateRelayOutageWithSystemSleep, systemSleepDiagnostic } from "./system-sleep-diagnostics.mjs";
export const RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS = 30_000;
export async function diagnoseRuntime({
  policy,
  runtimeDir,
  workspace,
  runFixedInternal,
  probeShell,
  managedJobManager,
  resourceCoordinatorSnapshot = null,
  relayStatus = () => null,
  controlPlaneState = {},
  throwIfCancelled,
}, context = {}) {
  throwIfCancelled(context);
  const checks = [{
    layer: "mcp-host-to-daemon",
    ok: true,
    detail: "This diagnostic request reached the local Machine Bridge runtime.",
  }, {
    layer: "machine-bridge-policy",
    ok: policy.execMode === "direct" || policy.execMode === "shell",
    detail: `profile=${policy.profile}; exec_mode=${policy.execMode}; unrestricted_paths=${policy.unrestrictedPaths}`,
  }];
  const relay = typeof relayStatus === "function" ? relayStatus() : null;
  checks.push(relay ? {
    layer: "remote-relay",
    ok: relay.ready === true,
    network_route: relay.network_route || "unknown",
    network_route_scope: relay.network_route_scope || "unknown",
    outage_active: relay.outage_active === true,
    outage_count: Number(relay.outage_count) || 0,
    last_close_category: relay.last_close_category || null,
    last_close_code: Number.isFinite(Number(relay.last_close_code)) ? Number(relay.last_close_code) : null,
    last_transport_error_class: relay.last_transport_error_class || null,
    last_disconnected_at: relay.last_disconnected_at || null,
    last_ready_at: relay.last_ready_at || null, last_ready_duration_ms: Number(relay.last_ready_duration_ms) || 0,
    https_fallback_last_takeover_ms: Number(relay.https_fallback_last_takeover_ms) || 0, next_reconnect_in_ms: Number(relay.next_reconnect_in_ms) || 0,
    heartbeat: relay.heartbeat || null,
  } : {
    layer: "remote-relay", ok: false, skipped: true, transport: "stdio-or-local",
  });
  checks.push(await systemNetworkRouteCheck({ runFixedInternal, classifyError: classifyOperationalError, context }));
  const probe = join(runtimeDir, `.diagnostic-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "ok\n", { mode: 0o600, flag: "wx" });
    const { buffer } = await readBoundedFile(probe, 64, "diagnostic file");
    checks.push({ layer: "local-filesystem", ok: buffer.toString("utf8") === "ok\n", error_class: null });
  } catch (error) {
    checks.push({ layer: "local-filesystem", ok: false, error_class: classifyOperationalError(error) });
  } finally {
    await rm(probe, { force: true }).catch(() => { /* Diagnostic scratch cleanup cannot change the already-observed probe result. */ });
  }
  if (policy.execMode === "direct" || policy.execMode === "shell") {
    const direct = await runFixedInternal(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS,
      true,
      1024,
      context,
      workspace,
    ).catch((error) => ({ code: 127, stdout: "", stderr: "", error_class: classifyOperationalError(error) }));
    checks.push({
      layer: "local-process-spawn",
      ok: direct.code === 0 && direct.stdout === "ok",
      error_class: direct.error_class || (direct.code === 0 ? null : classifyOperationalError(direct.stderr || direct.stdout || "execution failed")),
    });
  } else {
    checks.push({ layer: "local-process-spawn", ok: false, skipped: true, error_class: "policy_denied" });
  }
  if (policy.execMode === "shell") {
    const result = await probeShell(context, RUNTIME_DIAGNOSTIC_PROCESS_TIMEOUT_MS)
      .catch((error) => ({ code: 127, error_class: classifyOperationalError(error) }));
    checks.push({
      layer: "local-shell",
      ok: result.code === 0,
      error_class: result.error_class || (result.code === 0 ? null : classifyOperationalError(result.stderr || result.stdout || "execution failed")),
    });
  } else {
    checks.push({ layer: "local-shell", ok: false, skipped: true, error_class: "policy_denied" });
  }
  const admissionDiagnostic = await resourceAdmissionDiagnostic(resourceCoordinatorSnapshot, classifyOperationalError);
  if (admissionDiagnostic.check) checks.push(admissionDiagnostic.check);
  const sleepDiagnostic = policy.execMode === "shell"
    ? await systemSleepDiagnostic({ runFixedInternal, context, workspace })
    : { snapshot: { supported: process.platform === "darwin", available: false, source: null, recent_sleep_intervals: [] }, check: { layer: "system-sleep-history", ok: false, skipped: true, error_class: "policy_denied" } };
  checks.push(sleepDiagnostic.check, { layer: "managed-job-storage", ...managedJobManager.diagnoseStorage() });
  const managedJobs = typeof managedJobManager.status === "function" ? managedJobManager.status(context) : null;
  const activity = diagnosticActivityProjection(controlPlaneState, admissionDiagnostic.snapshot, managedJobs, context);
  activity.state.systemSleep = sleepDiagnostic.snapshot;
  activity.state.eventLoopPauseAnalysis = correlateEventLoopStallWithSystemSleep(relay, sleepDiagnostic.snapshot); activity.state.relayOutageAnalysis = correlateRelayOutageWithSystemSleep(relay, sleepDiagnostic.snapshot);
  const resources = managedJobManager.listResources();
  checks.push({
    layer: "local-resource-registry",
    ok: resources.resources.every((resource) => resource.available),
    registered: resources.count,
    unavailable: resources.resources
      .filter((resource) => !resource.available)
      .map((resource) => ({ name: resource.name, error_class: resource.error_class })),
  });
  return {
    request_reached_local_runtime: true,
    interpretation: diagnosticInterpretation(),
    policy,
    ...diagnosticControlPlaneState(activity.state, relay),
    checks,
    ok: checks.filter((check) => !check.skipped).every((check) => check.ok),
  };
}
