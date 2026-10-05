import assert from "node:assert/strict";
import { LocalRuntime } from "../src/local/runtime.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFullAccessTest } from "../src/local/full-access-test.mjs";
import { policyProfile } from "../src/local/tools.mjs";
import { healthyResourceHost } from "./fixtures/healthy-resource-host.mjs";

const workspace = await mkdtemp(join(tmpdir(), "mbm-full-access-workspace-"));
const delayedRunner = join(workspace, "delayed-terminal.mjs");
const terminalMarker = join(workspace, "terminal-delay.json");
const savedNodeOptions = process.env.NODE_OPTIONS;
const savedTerminalMarker = process.env.MBM_FULL_TEST_TERMINAL_MARKER;
try {
  await writeFile(delayedRunner, String.raw`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
if (process.argv[1] === @RUNNER@) {
  const jobDir = process.argv[process.argv.indexOf("--job-dir") + 1];
  const rename = fs.renameSync;
  let delayed = false;
  fs.renameSync = (...args) => {
    const result = rename(...args);
    if (!delayed && args[1] === path.join(jobDir, "result.json")) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      fs.writeFileSync(process.env.MBM_FULL_TEST_TERMINAL_MARKER,
        JSON.stringify({ job_directory_retained: fs.existsSync(jobDir) }), { mode: 0o600 });
    }
    return result;
  };
  syncBuiltinESMExports();
}
`.replace("@RUNNER@", JSON.stringify(fileURLToPath(new URL("../src/local/job-runner.mjs", import.meta.url)))), { mode: 0o600 });
  process.env.NODE_OPTIONS = [savedNodeOptions, "--import=" + pathToFileURL(delayedRunner).href].filter(Boolean).join(" ");
  process.env.MBM_FULL_TEST_TERMINAL_MARKER = terminalMarker;
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
    const publication = JSON.parse(await readFile(terminalMarker, "utf8"));
    if (!publication.job_directory_retained) throw new Error("full-access cleanup removed the job directory before terminal publication settled");
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
  const sentinelsBefore = Object.keys(process.env).filter((key) => key.startsWith("MBM_FULL_TEST_")).sort();
  const stop = LocalRuntime.prototype.stop;
  let stoppedRoot;
  LocalRuntime.prototype.stop = async function () {
    await stop.call(this);
    stoppedRoot = dirname(this.managedJobManager.jobRoot);
    throw new Error("owned full-access stop failure");
  };
  try {
    await assert.rejects(runFullAccessTest({
      workspace,
      resourceCoordinatorOptions: { sampleHost: healthyResourceHost },
      runCommand: async (command) => ({ code: command === "ssh" ? 0 : 127, stdout: "", stderr: "" }),
    }), /owned full-access stop failure/);
  } finally {
    LocalRuntime.prototype.stop = stop;
    if (stoppedRoot) await rm(stoppedRoot, { recursive: true, force: true });
  }
  assert.deepEqual(Object.keys(process.env).filter((key) => key.startsWith("MBM_FULL_TEST_")).sort(), sentinelsBefore,
    "full-access stop failure retained its synthetic parent-environment sentinel");
  console.log(`full profile real-machine sandbox test ok (${repetitions} iteration${repetitions === 1 ? "" : "s"})`);
} finally {
  if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = savedNodeOptions;
  if (savedTerminalMarker === undefined) delete process.env.MBM_FULL_TEST_TERMINAL_MARKER;
  else process.env.MBM_FULL_TEST_TERMINAL_MARKER = savedTerminalMarker;
  await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
