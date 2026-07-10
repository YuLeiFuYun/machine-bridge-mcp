import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFullAccessTest } from "../src/local/full-access-test.mjs";
import { policyProfile } from "../src/local/tools.mjs";

const workspace = await mkdtemp(join(tmpdir(), "mbm-full-access-workspace-"));
try {
  const result = await runFullAccessTest({ workspace, policy: policyProfile("full", "explicit") });
  if (!result.ok) throw new Error(`full access test failed: ${JSON.stringify(result)}`);
  for (const required of [
    "full-policy-invariant", "unrestricted-filesystem", "direct-process-outside-workspace",
    "full-parent-environment", "shell-execution", "ssh-key-generation",
    "authorized-keys-sandbox-write", "ssh-client", "detached-managed-job",
  ]) {
    if (!result.checks.some((check) => check.name === required && check.ok)) throw new Error(`missing full-access check: ${required}`);
  }
  if (result.guarantees.external_cloud_or_remote_state_changed !== false) throw new Error("full access test changed external state");
  if (result.guarantees.host_or_connector_policy_overridden !== false) throw new Error("full access test claimed to override host policy");
  console.log("full profile real-machine sandbox test ok");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
