import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFullAccessTest } from "../src/local/full-access-test.mjs";
import { policyProfile } from "../src/local/tools.mjs";
import { healthyResourceHost } from "./fixtures/healthy-resource-host.mjs";

const workspace = await mkdtemp(join(tmpdir(), "mbm-full-access-workspace-"));
try {
  const repetitions = process.platform === "win32" ? 3 : 1;
  for (let iteration = 1; iteration <= repetitions; iteration += 1) {
    const externalProbes = [];
    const result = await runFullAccessTest({
      workspace,
      policy: policyProfile("full", "explicit"),
      resourceCoordinatorOptions: { sampleHost: healthyResourceHost },
      runCommand: async (command, args) => {
        externalProbes.push({ command, args });
        if (command === "ssh") return { code: 0, stdout: "host localhost\n", stderr: "" };
        if (command === "gcloud") return { code: 127, stdout: "", stderr: "not installed" };
        if (command === "sudo") return { code: 127, stdout: "", stderr: "not available" };
        throw new Error(`unexpected external full-access probe: ${command}`);
      },
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
    if (!externalProbes.some(({ command, args }) => command === "ssh" && args.join(" ").includes("-G localhost"))) {
      throw new Error("full access test lost the bounded SSH client configuration probe");
    }
  }
  console.log(`full profile real-machine sandbox test ok (${repetitions} iteration${repetitions === 1 ? "" : "s"})`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
