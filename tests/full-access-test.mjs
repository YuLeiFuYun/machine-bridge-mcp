import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFullAccessTest } from "../src/local/full-access-test.mjs";
import { policyProfile } from "../src/local/tools.mjs";

const workspace = await mkdtemp(join(tmpdir(), "mbm-full-access-workspace-"));
try {
  const repetitions = process.platform === "win32" ? 3 : 1;
  for (let iteration = 1; iteration <= repetitions; iteration += 1) {
    const result = await runFullAccessTest({
      workspace,
      policy: policyProfile("full", "explicit"),
      resourceCoordinatorOptions: { sampleHost: healthyResourceHost },
    });
    if (!result.ok) throw new Error(`full access test iteration ${iteration} failed: ${JSON.stringify(result)}`);
    for (const required of [
      "full-policy-invariant", "unrestricted-filesystem", "direct-process-outside-workspace",
      "full-parent-environment", "shell-execution", "ssh-key-generation",
      "authorized-keys-sandbox-write", "ssh-client", "detached-managed-job",
    ]) {
      if (!result.checks.some((check) => check.name === required && check.ok)) throw new Error(`missing full-access check in iteration ${iteration}: ${required}`);
    }
    if (result.guarantees.external_cloud_or_remote_state_changed !== false) throw new Error("full access test changed external state");
    if (result.guarantees.host_or_connector_policy_overridden !== false) throw new Error("full access test claimed to override host policy");
  }
  console.log(`full profile real-machine sandbox test ok (${repetitions} iteration${repetitions === 1 ? "" : "s"})`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function healthyResourceHost() {
  return {
    sampled_at_ms: Date.now(), cpu_cores: 8, total_memory_mb: 16 * 1024,
    cpu_busy_cores: 1, load1: 1, memory_free_percent: 50,
    pageouts_total: 0, swapouts_total: 0, pageouts_per_s: 0, swapouts_per_s: 0,
    disk_mb_per_s: 1, disk_iops: 10, disk_free_bytes: 125 * 1024 ** 3,
    disk_total_bytes: 460 * 1024 ** 3, thermal_warning: false,
  };
}
