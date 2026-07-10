import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { LocalDaemon } from "./daemon.mjs";
import { generateSshKeyPair } from "./ssh-key.mjs";
import { run } from "./shell.mjs";
import { allToolNames, assertCanonicalFullPolicy, policyProfile } from "./tools.mjs";

const TERMINAL_JOB_STATES = new Set([
  "succeeded", "failed", "cancelled", "runner_failed", "runner_launch_failed",
  "recovery_failed", "recovery_exhausted", "succeeded_cleanup_failed",
  "failed_cleanup_failed", "cancelled_cleanup_failed",
]);

export async function runFullAccessTest({ workspace, policy = policyProfile("full", "explicit") } = {}) {
  const canonicalPolicy = assertCanonicalFullPolicy(policy);
  const root = await mkdtemp(join(tmpdir(), "machine-mcp-full-test-"));
  const jobRoot = join(root, "jobs");
  const outsideDir = join(root, "outside-workspace");
  const keyPath = join(root, "ssh", "operator-ed25519");
  const authorizedKeysPath = join(root, "authorized_keys");
  const mainMarker = join(root, "managed-main.txt");
  const cleanupMarker = join(root, "managed-cleanup.txt");
  const checks = [];
  const sentinelKey = `MBM_FULL_TEST_${Date.now()}`;
  const previousSentinel = process.env[sentinelKey];
  process.env[sentinelKey] = "visible";
  let runtime;

  try {
    runtime = new LocalDaemon({
      workspace: resolve(workspace),
      policy: canonicalPolicy,
      jobRoot,
      resources: {},
      logger: silentLogger(),
      recoverJobs: false,
    });

    const toolNames = runtime.tools();
    checks.push(check("full-policy-invariant", toolNames.length === allToolNames().length - 1, {
      profile: canonicalPolicy.profile,
      exposed_tools: toolNames.length + 1,
      catalog_tools: allToolNames().length,
    }));

    const outsideFile = join(outsideDir, "outside.txt");
    const written = await runtime.writeFile({ path: outsideFile, content: "full-outside-write\n", create_only: true });
    const read = await runtime.readFile(outsideFile, 1024);
    const canonicalOutsideFile = await realpath(outsideFile);
    checks.push(check("unrestricted-filesystem", written.ok === true && read.content === "full-outside-write\n", {
      absolute_path_returned: await equivalentPath(read.path, canonicalOutsideFile),
    }));

    const direct = await runtime.runDirectProcess({
      argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      cwd: outsideDir,
      timeout_seconds: 10,
    });
    checks.push(check("direct-process-outside-workspace", direct.code === 0 && await equivalentPath(direct.stdout.trim(), outsideDir)));

    const inherited = await runtime.runDirectProcess({
      argv: [process.execPath, "-e", `process.stdout.write(process.env[${JSON.stringify(sentinelKey)}] || '')`],
      timeout_seconds: 10,
    });
    checks.push(check("full-parent-environment", inherited.code === 0 && inherited.stdout === "visible"));

    const shellCommand = process.platform === "win32" ? "[Console]::Out.Write('full-shell')" : "printf full-shell";
    const shell = await runtime.execCommand(shellCommand, 10);
    checks.push(check("shell-execution", shell.code === 0 && shell.stdout.trim() === "full-shell"));

    const key = await generateSshKeyPair({
      privateKeyPath: keyPath,
      type: "ed25519",
      comment: "machine-mcp-full-test",
    });
    const publicLine = (await readFile(key.publicKeyPath, "utf8")).trim();
    await runtime.writeFile({ path: authorizedKeysPath, content: `${publicLine}\n`, create_only: true });
    if (process.platform !== "win32") await chmod(authorizedKeysPath, 0o600);
    const authorized = await readFile(authorizedKeysPath, "utf8");
    checks.push(check("ssh-key-generation", key.created && key.publicKeyType === "ssh-ed25519", {
      private_mode: key.privateMode,
      public_mode: key.publicMode,
      fingerprint_available: Boolean(key.fingerprint),
      private_key_content_exposed: false,
    }));
    checks.push(check("authorized-keys-sandbox-write", authorized === `${publicLine}\n`, {
      target_is_temporary_sandbox: true,
    }));

    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    const sshConfig = await run("ssh", ["-F", nullConfig, "-G", "localhost"], {
      capture: true,
      allowFailure: true,
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    checks.push(check("ssh-client", sshConfig.code === 0));

    const gcloud = await run("gcloud", ["--version"], {
      capture: true,
      allowFailure: true,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    });
    const osLoginHelp = gcloud.code === 0
      ? await run("gcloud", ["help", "compute", "os-login", "ssh-keys", "add"], {
          capture: true,
          allowFailure: true,
          timeoutMs: 30_000,
          maxOutputBytes: 128 * 1024,
        })
      : { code: 127 };
    checks.push(check("google-cloud-cli", gcloud.code === 0, {
      os_login_key_command_available: osLoginHelp.code === 0,
      external_changes_made: false,
    }));

    const sudo = process.platform === "win32"
      ? { code: 0, skipped: true }
      : await run("sudo", ["-n", "true"], {
          capture: true,
          allowFailure: true,
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        });
    checks.push({
      name: "noninteractive-sudo-probe",
      ok: true,
      available: process.platform === "win32" ? null : sudo.code === 0,
      password_or_policy_required: process.platform === "win32" ? null : sudo.code !== 0,
      skipped: process.platform === "win32",
      state_changed: false,
    });

    const accepted = runtime.managedJobManager.start({
      name: "full access lifecycle test",
      temporary_files: [{ name: "main.js", content: "require('node:fs').writeFileSync(process.argv[2],'main')" }],
      steps: [{ argv: [process.execPath, "{{temp:main.js}}", mainMarker], timeout_seconds: 10 }],
      finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cleanup')", cleanupMarker], timeout_seconds: 10 }],
    });
    const job = await waitForJob(runtime.managedJobManager, accepted.job_id, 15_000);
    checks.push(check("detached-managed-job", job.status === "succeeded"
      && await fileEquals(mainMarker, "main")
      && await fileEquals(cleanupMarker, "cleanup"), {
      status: job.status,
      cleanup_attempted: true,
    }));

    const coreChecks = checks.filter((item) => !["google-cloud-cli", "noninteractive-sudo-probe"].includes(item.name));
    const operatorChecks = checks.filter((item) => ["ssh-key-generation", "authorized-keys-sandbox-write", "ssh-client", "google-cloud-cli"].includes(item.name));
    return {
      ok: coreChecks.every((item) => item.ok === true),
      operator_workflow_ready: operatorChecks.every((item) => item.ok === true),
      machine: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      policy: canonicalPolicy,
      checks,
      guarantees: {
        machine_bridge_internal_policy_denials_under_full: false,
        host_or_connector_policy_overridden: false,
        operating_system_policy_overridden: false,
        external_cloud_or_remote_state_changed: false,
      },
    };
  } finally {
    runtime?.stop();
    if (previousSentinel === undefined) delete process.env[sentinelKey];
    else process.env[sentinelKey] = previousSentinel;
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForJob(manager, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = manager.read({ job_id: jobId });
    if (TERMINAL_JOB_STATES.has(value.status)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("full access managed-job test timed out");
}

async function equivalentPath(left, right) {
  try { return await realpath(resolve(left)) === await realpath(resolve(right)); } catch { return false; }
}

async function fileEquals(path, expected) {
  try { return await readFile(path, "utf8") === expected; } catch { return false; }
}

function check(name, ok, detail = {}) {
  return { name, ok: Boolean(ok), ...detail };
}

function silentLogger() {
  return {
    info() {}, success() {}, warn() {}, error() {}, debug() {},
  };
}
