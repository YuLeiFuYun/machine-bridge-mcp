import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyOperationalError } from "./log.mjs";
import { readBoundedFile } from "./workspace-file-service.mjs";

export async function diagnoseRuntime({
  policy,
  runtimeDir,
  workspace,
  runProcess,
  probeShell,
  managedJobManager,
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

  const probe = join(runtimeDir, `.diagnostic-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "ok\n", { mode: 0o600, flag: "wx" });
    const { buffer } = await readBoundedFile(probe, 64, "diagnostic file");
    checks.push({ layer: "local-filesystem", ok: buffer.toString("utf8") === "ok\n", error_class: null });
  } catch (error) {
    checks.push({ layer: "local-filesystem", ok: false, error_class: classifyOperationalError(error) });
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }

  if (policy.execMode === "direct" || policy.execMode === "shell") {
    const direct = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      5000,
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
    const result = await probeShell(context)
      .catch((error) => ({ code: 127, error_class: classifyOperationalError(error) }));
    checks.push({
      layer: "local-shell",
      ok: result.code === 0,
      error_class: result.error_class || (result.code === 0 ? null : classifyOperationalError(result.stderr || result.stdout || "execution failed")),
    });
  } else {
    checks.push({ layer: "local-shell", ok: false, skipped: true, error_class: "policy_denied" });
  }

  checks.push({ layer: "managed-job-storage", ...managedJobManager.diagnoseStorage() });
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
    interpretation: {
      tool_call_blocked_before_response: "host/platform or connector gateway",
      diagnostic_reached_daemon_but_spawn_failed: "local OS, endpoint security, shell configuration, or Machine Bridge policy",
      managed_job_accepted_then_later_tools_blocked: "job continues independently; inspect with local CLI or a later read_job call",
    },
    policy,
    checks,
    ok: checks.filter((check) => !check.skipped).every((check) => check.ok),
  };
}
