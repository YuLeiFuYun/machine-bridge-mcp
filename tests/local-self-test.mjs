import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/local/shell.mjs";
import { parseArgs, resolvePolicy, validateCommandOptions, validateLoggingOptions, validatePositionals } from "../src/local/cli.mjs";
import { daemonSelfTest } from "./daemon-self-test.mjs";
import { formatFields, sanitizeLogText } from "../src/local/log.mjs";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { daemonArgs, stableNodeExecutable, systemdQuote, trimAutostartLogs } from "../src/local/service.mjs";
import { allToolNames, assertCanonicalFullPolicy, MCP_PROTOCOL_VERSION, toolsForPolicy } from "../src/local/tools.mjs";
import { acquireDaemonLock, acquireStartupLock, ensureWorkerSecrets, loadGlobalConfig, loadState, previewSecret, redactState, removeStateRoot, resolveWorkspace, saveState, selectedWorkspace, setSelectedWorkspace, validateStateRootForRemoval } from "../src/local/state.mjs";

await daemonSelfTest();
await stateSelfTest();
await activeDaemonPolicyMutationSelfTest();
await clientConfigDefaultSelfTest();
await resourceCliSelfTest();
await cliSelfTest();
await logSelfTest();
await serviceSelfTest();
await ciBootstrapSelfTest();
await shellSelfTest();
await workerSourceSelfTest();
console.log("local daemon/state/cli/log/service/worker self-test ok");

async function stateSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-test-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-state-workspace-"));
  try {
    const canonicalWorkspace = resolveWorkspace(workspace);
    setSelectedWorkspace(workspace, stateRoot);
    if (selectedWorkspace(stateRoot) !== canonicalWorkspace) throw new Error("selected workspace was not persisted canonically");
    const state = loadState(workspace, { stateDir: stateRoot });
    if (state.schemaVersion !== 5) throw new Error("unexpected state schema version");
    ensureWorkerSecrets(state, { rotateSecrets: true });
    state.oversized = "x".repeat(2 * 1024 * 1024 + 1);
    expectThrow(() => saveState(state), "state JSON exceeds");
    delete state.oversized;
    const lock = acquireDaemonLock(state);
    if (!lock.acquired) throw new Error("first daemon lock acquisition failed");
    try {
      const duplicate = acquireDaemonLock(state);
      if (duplicate.acquired) throw new Error("duplicate daemon lock acquisition should fail");
      if (duplicate.owner?.pid !== process.pid) throw new Error("duplicate daemon lock owner was not reported");
    } finally {
      lock.release();
    }
    const relock = acquireDaemonLock(state);
    if (!relock.acquired) throw new Error("daemon lock was not released");
    relock.release();

    const startup = acquireStartupLock(state);
    if (!startup.acquired) throw new Error("startup lock acquisition failed");
    const duplicateStartup = acquireStartupLock(state);
    if (duplicateStartup.acquired) throw new Error("duplicate startup lock acquisition should fail");
    startup.release();
    const startupAgain = acquireStartupLock(state);
    if (!startupAgain.acquired) throw new Error("startup lock was not released");
    startupAgain.release();

    const redacted = redactState(state);
    if (redacted.worker.oauthPassword !== "<redacted>") throw new Error("oauthPassword was not fully redacted");
    if (redacted.worker.daemonSecret !== "<redacted>") throw new Error("daemonSecret was not fully redacted");
    if (redacted.worker.oauthTokenVersion !== "<redacted>") throw new Error("oauthTokenVersion was not fully redacted");
    if (previewSecret(state.worker.oauthPassword) !== "<redacted>") throw new Error("previewSecret did not fully redact secret");
    state.resources = { "private-key": { kind: "file", path: join(workspace, "private-key"), size: 10, mode: "0600" } };
    const resourceRedacted = redactState(state);
    if (resourceRedacted.resources["private-key"].path !== "<local-resource-path>") throw new Error("redacted state exposed a local resource path");

    state.localApi = {
      apiKey: "old-local-api-key",
      upstreamUrl: "https://api.example.test/v1",
      upstreamKey: "old-upstream-key",
      upstreamModel: "old-upstream-model",
    };
    saveState(state);
    const profileEntries = await readdir(state.paths.profileDir);
    if (profileEntries.some(name => name.endsWith(".tmp"))) throw new Error("atomic state write left a temporary file");
    const migrated = loadState(workspace, { stateDir: stateRoot });
    if ("localApi" in migrated) throw new Error("legacy local API state was not removed");
    migrated.policy = { profile: "custom", allowWrite: true, execMode: "shell", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
    saveState(migrated);
    const policyReload = loadState(workspace, { stateDir: stateRoot });
    policyReload.policy = resolvePolicy({}, policyReload.policy);
    saveState(policyReload);
    const policyPersisted = loadState(workspace, { stateDir: stateRoot });
    if (policyPersisted.policy.profile !== "full" || policyPersisted.policy.origin !== "migrated" || policyPersisted.policy.revision !== 3) {
      throw new Error("migrated policy origin/revision was not persisted");
    }

    const backupsBefore = (await readdir(state.paths.profileDir)).filter(name => name.startsWith("state.json.corrupt-"));
    await writeFile(state.paths.statePath, "{not-json", "utf8");
    const recovered = loadState(workspace, { stateDir: stateRoot });
    if (recovered.workspace.path !== canonicalWorkspace) throw new Error("corrupt state recovery failed");
    const backups = (await readdir(state.paths.profileDir)).filter(name => name.startsWith("state.json.corrupt-"));
    if (backups.length !== backupsBefore.length + 1) throw new Error("corrupt state recovery did not create exactly one new backup");
    const newestBackup = backups.find(name => !backupsBefore.includes(name));
    if (!newestBackup || await readFile(join(state.paths.profileDir, newestBackup), "utf8") !== "{not-json") {
      throw new Error("corrupt state backup did not preserve the original bytes");
    }
    await writeFile(join(stateRoot, "config.json"), "{invalid-config", { mode: 0o600 });
    loadGlobalConfig(stateRoot);
    const configBackups = (await readdir(stateRoot)).filter(name => /^config\.json\.corrupt-/.test(name));
    if (configBackups.length !== 1) throw new Error("corrupt global config did not create one bounded backup");
    const safeRemoval = validateStateRootForRemoval(stateRoot);
    if (!safeRemoval.exists || safeRemoval.root !== state.paths.stateRoot) throw new Error("safe state root validation failed after corrupt config recovery");

    const legacyStateRoot = await mkdtemp(join(tmpdir(), "mbm-legacy-state-"));
    try {
      await writeFile(join(legacyStateRoot, ".machine-bridge-mcp-state"), "machine-bridge-mcp state root\n", "utf8");
      const legacyState = loadState(workspace, { stateDir: legacyStateRoot });
      const marker = JSON.parse(await readFile(join(legacyState.paths.stateRoot, ".machine-bridge-mcp-state"), "utf8"));
      if (marker.app !== "machine-bridge-mcp" || marker.schema !== 1) throw new Error("legacy state marker was not migrated");
      removeStateRoot(legacyStateRoot);
    } finally {
      await rm(legacyStateRoot, { recursive: true, force: true }).catch(() => {});
    }

    const aliasStateRoot = await mkdtemp(join(tmpdir(), "mbm-alias-state-"));
    try {
      const legacyHash = "a".repeat(24);
      const legacyProfile = join(aliasStateRoot, "profiles", legacyHash);
      await mkdir(legacyProfile, { recursive: true });
      await writeFile(join(legacyProfile, "state.json"), `${JSON.stringify({
        schemaVersion: 4,
        workspace: { path: workspace, hash: legacyHash },
        worker: { oauthPassword: "legacy-password", daemonSecret: "legacy-daemon", oauthTokenVersion: "legacy-version" },
        policy: {},
      }, null, 2)}
`, { mode: 0o600 });
      const adoptedAlias = loadState(canonicalWorkspace, { stateDir: aliasStateRoot });
      if (await realpath(adoptedAlias.paths.profileDir) !== await realpath(legacyProfile) || adoptedAlias.workspace.hash !== legacyHash || adoptedAlias.worker.oauthPassword !== "legacy-password") {
        throw new Error("canonical workspace did not reuse a matching legacy alias profile");
      }
      removeStateRoot(aliasStateRoot);
    } finally {
      await rm(aliasStateRoot, { recursive: true, force: true }).catch(() => {});
    }

    const lookalike = await mkdtemp(join(tmpdir(), "mbm-lookalike-state-"));
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(lookalike, "profiles")));
      expectThrow(() => loadState(workspace, { stateDir: lookalike }), "does not contain recognizable");
    } finally {
      await rm(lookalike, { recursive: true, force: true }).catch(() => {});
    }

    const unrelated = await mkdtemp(join(tmpdir(), "mbm-unrelated-test-"));
    try {
      await writeFile(join(unrelated, "keep.txt"), "do not delete", "utf8");
      expectThrow(() => validateStateRootForRemoval(unrelated), "unrelated entries");
      if (!(await stat(join(unrelated, "keep.txt"))).isFile()) throw new Error("unsafe state root validation modified unrelated data");
    } finally {
      await rm(unrelated, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    try { removeStateRoot(stateRoot); } catch { await rm(stateRoot, { recursive: true, force: true }).catch(() => {}); }
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function activeDaemonPolicyMutationSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-policy-lock-test-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-policy-lock-workspace-"));
  const workspace = await realpath(workspaceRaw);
  try {
    const state = loadState(workspace, { stateDir: stateRoot });
    state.policy = resolvePolicy({ profile: "review" }, {});
    ensureWorkerSecrets(state, { rotateSecrets: true });
    saveState(state);
    const daemonLock = acquireDaemonLock(state);
    if (!daemonLock.acquired) throw new Error("policy mutation test could not acquire daemon lock");
    try {
      const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
      const child = spawnSync(process.execPath, [
        entry,
        "start",
        "--daemon-only",
        "--workspace", workspace,
        "--state-dir", stateRoot,
        "--profile", "full",
        "--json",
      ], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`locked start failed unexpectedly: ${child.stderr || child.stdout}`);
      const output = JSON.parse(child.stdout.trim());
      if (output.requested_changes_applied !== false || !String(output.notice || "").includes("not applied")) {
        throw new Error("locked JSON start did not report that policy changes were rejected");
      }
      if (output.mcp?.connection_password !== "<redacted>" || child.stdout.includes("mcp_password_")) {
        throw new Error("JSON start exposed connection credentials without an explicit print flag");
      }
      const unchanged = loadState(workspace, { stateDir: stateRoot });
      if (unchanged.policy.profile !== "review" || unchanged.policy.allowWrite || unchanged.policy.execMode !== "off") {
        throw new Error("active daemon lock allowed persisted policy mutation");
      }
    } finally {
      daemonLock.release();
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

async function clientConfigDefaultSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-client-config-test-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-client-config-workspace-"));
  const workspace = await realpath(workspaceRaw);
  try {
    const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [
      entry,
      "client-config",
      "--client", "all",
      "--workspace", workspace,
      "--state-dir", stateRoot,
      "--json",
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`client-config failed: ${child.stderr || child.stdout}`);
    const output = JSON.parse(child.stdout.trim());
    if (output.profile !== "full") throw new Error("client-config did not default to full profile");
    const args = output.claude?.mcpServers?.["machine-bridge"]?.args || [];
    const profileIndex = args.indexOf("--profile");
    if (profileIndex < 0 || args[profileIndex + 1] !== "full") throw new Error("generated client config did not persist full profile");
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

async function resourceCliSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-resource-cli-state-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-resource-cli-workspace-"));
  const workspace = await realpath(workspaceRaw);
  const resourceFile = join(workspace, "credential-file.txt");
  await writeFile(resourceFile, "local-value-not-returned", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(resourceFile, 0o600);
  const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
  try {
    const added = spawnSync(process.execPath, [entry, "resource", "add", "test-key", resourceFile, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (added.error) throw added.error;
    if (added.status !== 0) throw new Error(`resource add failed: ${added.stderr || added.stdout}`);
    const addedJson = JSON.parse(added.stdout);
    if (addedJson.contents_exposed !== false || addedJson.paths_exposed !== false || "path" in addedJson || added.stdout.includes(resourceFile) || added.stdout.includes("local-value-not-returned")) {
      throw new Error("resource add exposed file contents or local path by default");
    }

    const generatedKeyPath = join(workspace, "generated-operator-key");
    const generated = spawnSync(process.execPath, [entry, "resource", "generate-ssh-key", "generated-key", generatedKeyPath, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 30_000,
    });
    if (generated.error) throw generated.error;
    if (generated.status !== 0) throw new Error(`SSH key resource generation failed: ${generated.stderr || generated.stdout}`);
    const generatedJson = JSON.parse(generated.stdout);
    if (!generatedJson.created || !generatedJson.registered || generatedJson.private_key_content_exposed !== false || !generatedJson.fingerprint || generatedJson.paths_exposed !== false || "private_key_path" in generatedJson || generated.stdout.includes(generatedKeyPath)) {
      throw new Error("SSH key generation result is incomplete or exposed private content/path by default");
    }
    if (!(await stat(generatedKeyPath)).isFile() || !(await stat(`${generatedKeyPath}.pub`)).isFile()) throw new Error("SSH key pair was not created");
    if (process.platform !== "win32" && ((await stat(generatedKeyPath)).mode & 0o777) !== 0o600) throw new Error("generated private key mode is not 0600");
    const generatedAgain = spawnSync(process.execPath, [entry, "resource", "generate-ssh-key", "generated-key", generatedKeyPath, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 30_000,
    });
    if (generatedAgain.status !== 0 || JSON.parse(generatedAgain.stdout).created !== false) throw new Error("SSH key resource generation is not idempotent");

    const state = loadState(workspace, { stateDir: stateRoot });
    if (state.resources["test-key"]?.path !== resourceFile) throw new Error("resource add did not persist the canonical path");
    const manager = new ManagedJobManager({
      jobRoot: join(state.paths.profileDir, "jobs"),
      workspace,
      policy: { allowWrite: true, execMode: "direct", minimalEnv: false, unrestrictedPaths: true },
      resourceStatePath: state.paths.statePath,
    });
    if (manager.listResources().count !== 2) throw new Error("daemon-style resource reload did not read updated state");

    const listed = spawnSync(process.execPath, [entry, "resource", "list", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (listed.status !== 0) throw new Error(`resource list failed: ${listed.stderr || listed.stdout}`);
    const listedJson = JSON.parse(listed.stdout);
    if (!listedJson.resources?.["test-key"] || !listedJson.resources?.["generated-key"] || listedJson.paths_exposed !== false || listedJson.workspace !== "<local-workspace>" || "path" in listedJson.resources["test-key"] || listed.stdout.includes(resourceFile) || listed.stdout.includes(generatedKeyPath) || listed.stdout.includes("local-value-not-returned")) {
      throw new Error("resource list omitted an alias or exposed contents/paths by default");
    }
    const listedWithPaths = spawnSync(process.execPath, [entry, "resource", "list", "--show-paths", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    const listedWithPathsJson = JSON.parse(listedWithPaths.stdout);
    if (listedWithPaths.status !== 0 || listedWithPathsJson.paths_exposed !== true || listedWithPathsJson.resources?.["test-key"]?.path !== resourceFile) {
      throw new Error("resource list did not honor explicit --show-paths");
    }

    const checked = spawnSync(process.execPath, [entry, "resource", "check", "test-key", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    const checkedJson = JSON.parse(checked.stdout);
    if (checked.status !== 0 || checkedJson.contents_exposed !== false || checkedJson.paths_exposed !== false || "path" in checkedJson || checked.stdout.includes(resourceFile)) {
      throw new Error("resource check failed or exposed contents/path by default");
    }

    const jobs = spawnSync(process.execPath, [entry, "job", "list", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (jobs.status !== 0 || !Array.isArray(JSON.parse(jobs.stdout).jobs)) throw new Error("local job list fallback failed");

    const approvedMarker = join(workspace, "approved-by-cli.txt");
    const stagedForCli = manager.stage({
      name: "CLI approval",
      steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cli-approved')", approvedMarker], env_resources: { MBM_REVIEW_ONLY: "test-key" }, timeout_seconds: 10 }],
    });
    const inspectedPlan = spawnSync(process.execPath, [entry, "job", "inspect", stagedForCli.job_id, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (inspectedPlan.status !== 0) throw new Error(`local job inspect failed: ${inspectedPlan.stderr || inspectedPlan.stdout}`);
    const inspectionJson = JSON.parse(inspectedPlan.stdout);
    const reviewedResource = inspectionJson.review_plan?.resources?.["test-key"];
    if (!inspectionJson.review_plan || !reviewedResource || "path" in reviewedResource || "sha256" in reviewedResource || JSON.stringify(inspectionJson).includes(resourceFile)) {
      throw new Error("local plan inspection omitted the plan or exposed a resource source path/hash");
    }
    const cliApproved = spawnSync(process.execPath, [entry, "job", "approve", stagedForCli.job_id, "--workspace", workspace, "--state-dir", stateRoot, "--json", "--yes"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (cliApproved.status !== 0 || JSON.parse(cliApproved.stdout).approval !== "local-operator") throw new Error(`local job approve failed: ${cliApproved.stderr || cliApproved.stdout}`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await existsForSelfTest(approvedMarker)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (await readFile(approvedMarker, "utf8") !== "cli-approved") throw new Error("local job approve did not execute the staged job");

    const submittedMarker = join(workspace, "submitted-by-cli.txt");
    const planFile = join(workspace, "managed-plan.json");
    await writeFile(planFile, JSON.stringify({
      name: "local CLI fallback",
      steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'submitted')", submittedMarker], timeout_seconds: 10 }],
    }), "utf8");
    if (process.platform !== "win32") {
      const linkedPlan = join(workspace, "linked-plan.json");
      await symlink(planFile, linkedPlan);
      const linked = spawnSync(process.execPath, [entry, "job", "submit", linkedPlan, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
        encoding: "utf8", timeout: 10_000,
      });
      if (linked.status === 0 || !String(linked.stderr).includes("must not be a symbolic link")) {
        throw new Error("local job submit accepted a symbolic-link plan file");
      }
    }
    const submitted = spawnSync(process.execPath, [entry, "job", "submit", planFile, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (submitted.status !== 0) throw new Error(`local job submit failed: ${submitted.stderr || submitted.stdout}`);
    const submittedId = JSON.parse(submitted.stdout).job_id;
    let submittedStatus = "";
    const submittedTerminal = new Set(["succeeded", "failed", "cancelled", "runner_failed", "runner_launch_failed", "recovery_failed", "recovery_exhausted", "succeeded_cleanup_failed", "failed_cleanup_failed", "cancelled_cleanup_failed"]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const read = spawnSync(process.execPath, [entry, "job", "read", submittedId, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
        encoding: "utf8", timeout: 10_000,
      });
      if (read.status !== 0) throw new Error(`local job read failed: ${read.stderr || read.stdout}`);
      submittedStatus = JSON.parse(read.stdout).status;
      if (submittedTerminal.has(submittedStatus)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (submittedStatus !== "succeeded" || await readFile(submittedMarker, "utf8").catch(() => "") !== "submitted") {
      const currentState = loadState(workspace, { stateDir: stateRoot });
      const jobDir = join(currentState.paths.profileDir, "jobs", submittedId);
      const diagnostics = {};
      for (const name of ["status.json", "result.json", "runner.out.log", "runner.err.log"]) {
        try { diagnostics[name] = await readFile(join(jobDir, name), "utf8"); } catch {}
      }
      throw new Error(`local CLI fallback job did not complete: ${submittedStatus}; diagnostics=${JSON.stringify(diagnostics)}`);
    }

    const activeJob = manager.start({
      name: "block uninstall while active",
      steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"], timeout_seconds: 60 }],
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = manager.read({ job_id: activeJob.job_id });
      if (value.status === "running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    const uninstallBlocked = spawnSync(process.execPath, [entry, "uninstall", "--state-dir", stateRoot, "--keep-worker", "--yes"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (uninstallBlocked.status === 0 || !String(uninstallBlocked.stderr).includes("managed jobs are active")) {
      throw new Error(`uninstall did not refuse an active managed job: ${uninstallBlocked.stderr || uninstallBlocked.stdout}`);
    }
    manager.cancel({ job_id: activeJob.job_id });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = manager.read({ job_id: activeJob.job_id });
      if (!["queued", "running", "cleaning", "interrupted"].includes(value.status)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    const removed = spawnSync(process.execPath, [entry, "resource", "remove", "test-key", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (removed.status !== 0 || JSON.parse(removed.stdout).removed !== true) throw new Error("resource remove failed");
    const resourcesAfterRemoval = manager.listResources();
    if (resourcesAfterRemoval.count !== 1 || resourcesAfterRemoval.resources[0]?.name !== "generated-key") {
      throw new Error("resource removal affected the wrong alias or was not visible without restart");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

function cliSelfTest() {
  const parsed = parseArgs(["--no-write", "/tmp/example", "--unrestricted-paths=false", "--worker-name", "mbm-test"]);
  if (parsed.noWrite !== true || parsed._[0] !== "/tmp/example") throw new Error("boolean option consumed positional workspace");
  if (parsed.unrestrictedPaths !== false || parsed.workerName !== "mbm-test") throw new Error("CLI option parsing failed");
  expectThrow(() => parseArgs(["--unknown-option"]), "Unknown option");
  expectThrow(() => parseArgs(["--api"]), "Unknown option");
  expectThrow(() => parseArgs(["--workspace"]), "requires a value");
  expectThrow(() => parseArgs(["--quiet", "--quiet"]), "Duplicate option");
  expectThrow(() => parseArgs(["--quiet=maybe"]), "expects true or false");
  expectThrow(() => validatePositionals("start", { _: ["one", "two"] }), "at most one positional");
  expectThrow(() => validatePositionals("start", { _: ["one"], workspace: "two" }), "both positionally");
  expectThrow(() => validatePositionals("uninstall", { _: ["unexpected"] }), "does not accept positional");
  expectThrow(() => validateCommandOptions("uninstall", { _: [], workspace: "/tmp/project" }), "not valid for uninstall");
  expectThrow(() => validateCommandOptions("doctor", { _: [], fullEnv: true }), "not valid for doctor");
  validateCommandOptions("full-test", { _: [], workspace: "/tmp/project", json: true });
  validateCommandOptions("start", { _: [], unrestrictedPaths: true, noExec: true, logLevel: "warn" });
  validateLoggingOptions({ logLevel: "warn" });
  expectThrow(() => validateLoggingOptions({ logLevel: "trace" }), "log level must be");
  expectThrow(() => validateLoggingOptions({ quiet: true, verbose: true }), "cannot be used together");
  expectThrow(() => validateLoggingOptions({ logLevel: "warn", verbose: true }), "cannot be combined");
  validateCommandOptions("stdio", { _: [], profile: "agent", execMode: "direct" });
  validateCommandOptions("client-config", { _: [], client: "cursor", profile: "review" });
  validateCommandOptions("resource", { _: ["add", "key", "/tmp/key"], allowInsecurePermissions: true, showPaths: true, json: true });
  validateCommandOptions("job", { _: ["read", "job_abcdefghijklmnopqrstuvwxyz"], json: true });
  validatePositionals("workspace", { _: ["set", "/tmp/project"] });
  validatePositionals("service", { _: ["install", "/tmp/project"] });
  validatePositionals("stdio", { _: ["/tmp/project"] });
  validatePositionals("client-config", { _: ["codex"] });
  validatePositionals("resource", { _: ["add", "test-key", "/tmp/key"] });
  validatePositionals("resource", { _: ["generate-ssh-key", "test-key", "/tmp/key"] });
  validatePositionals("full-test", { _: ["/tmp/project"] });
  validatePositionals("job", { _: ["read", "job_abcdefghijklmnopqrstuvwxyz"] });
  validatePositionals("job", { _: ["submit", "/tmp/plan.json"] });
  validatePositionals("job", { _: ["approve", "job_abcdefghijklmnopqrstuvwxyz"] });
  validatePositionals("job", { _: ["inspect", "job_abcdefghijklmnopqrstuvwxyz"] });
  expectThrow(() => validatePositionals("resource", { _: ["add", "name", "path", "extra"] }), "too many positional");

  const defaultPolicy = resolvePolicy({}, {});
  if (
    defaultPolicy.profile !== "full" ||
    !defaultPolicy.allowWrite ||
    defaultPolicy.execMode !== "shell" ||
    !defaultPolicy.unrestrictedPaths ||
    defaultPolicy.minimalEnv ||
    !defaultPolicy.exposeAbsolutePaths ||
    defaultPolicy.origin !== "default"
  ) {
    throw new Error("new-workspace default policy is not maximum-permission full mode");
  }
  assertCanonicalFullPolicy(defaultPolicy);
  if (toolsForPolicy(defaultPolicy).length !== allToolNames().length) throw new Error("canonical full policy does not expose every tool");
  const inconsistentFull = resolvePolicy({}, { profile: "full", origin: "explicit", revision: 3, allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (inconsistentFull.profile !== "full" || !inconsistentFull.allowWrite || inconsistentFull.execMode !== "shell" || !inconsistentFull.unrestrictedPaths || inconsistentFull.minimalEnv || !inconsistentFull.exposeAbsolutePaths) {
    throw new Error("declared full profile was not repaired to canonical maximum permissions");
  }
  assertCanonicalFullPolicy(inconsistentFull);
  const review = resolvePolicy({ profile: "review" }, {});
  const legacy = resolvePolicy({}, { profile: "custom", allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (legacy.profile !== "full" || legacy.origin !== "migrated" || !legacy.unrestrictedPaths || legacy.minimalEnv || !legacy.exposeAbsolutePaths) {
    throw new Error("legacy implicit default policy was not migrated to full");
  }
  const staleDefault = resolvePolicy({}, { profile: "review", origin: "default", revision: 1, allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (staleDefault.profile !== "full" || staleDefault.origin !== "default" || staleDefault.revision !== 3) {
    throw new Error("outdated default-origin policy did not follow the current policy revision");
  }
  const staleExplicit = resolvePolicy({}, { profile: "review", origin: "explicit", revision: 1, allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (staleExplicit.profile !== "review" || staleExplicit.origin !== "explicit") {
    throw new Error("explicit policy was overwritten by a default revision upgrade");
  }
  const legacyReview = resolvePolicy({}, { profile: "review", allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (legacyReview.profile !== "review" || legacyReview.origin !== "legacy-preserved" || legacyReview.allowWrite) {
    throw new Error("legacy explicit restrictive policy was not preserved");
  }
  const agent = resolvePolicy({ profile: "agent" }, {});
  if (!agent.allowWrite || agent.execMode !== "direct") throw new Error("agent profile is incorrect");
  const restrictedAgent = resolvePolicy({ profile: "agent", noExec: true, absolutePaths: true }, {});
  if (restrictedAgent.profile !== "custom" || restrictedAgent.execMode !== "off" || restrictedAgent.exposeAbsolutePaths !== true) throw new Error("policy overrides are incorrect");
  expectThrow(() => resolvePolicy({ profile: "unsafe" }, {}), "--profile must be one of");
  expectThrow(() => resolvePolicy({ execMode: "maybe" }, {}), "--exec-mode must be");

  const defaultNames = new Set(toolsForPolicy(defaultPolicy).map((tool) => tool.name));
  if (!defaultNames.has("write_file") || !defaultNames.has("run_process") || !defaultNames.has("exec_command") || !defaultNames.has("stage_job") || !defaultNames.has("start_job") || !defaultNames.has("diagnose_runtime")) throw new Error("default full profile omits maximum tool capabilities");
  const reviewNames = new Set(toolsForPolicy(review).map((tool) => tool.name));
  if (reviewNames.has("write_file") || reviewNames.has("run_process") || reviewNames.has("exec_command")) throw new Error("review profile exposes mutation tools");
  const agentNames = new Set(toolsForPolicy(agent).map((tool) => tool.name));
  if (!agentNames.has("apply_patch") || !agentNames.has("run_process") || !agentNames.has("start_job") || agentNames.has("exec_command")) throw new Error("agent profile tool inventory is incorrect");
  if (MCP_PROTOCOL_VERSION !== "2025-11-25") throw new Error("MCP protocol version drifted");
}

function logSelfTest() {
  const rendered = formatFields({
    token: "mcp_at_should-not-appear",
    nested: { password: "secret", message: "mcp_password_abcdef\nforged" },
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  if (rendered.includes("should-not-appear") || rendered.includes("password_abcdef") || rendered.includes("Bearer abcdef")) {
    throw new Error("structured log secret redaction failed");
  }
  if (rendered.includes("\nforged")) throw new Error("structured log newline injection was not escaped");
  if (sanitizeLogText("ok\n[error] forged").includes("\n[error]")) throw new Error("log message newline injection was not escaped");
  if (sanitizeLogText("x".repeat(10_000)).length > 2048) throw new Error("log message length was not bounded");
  const privateHome = process.env.HOME || process.env.USERPROFILE || "/home/test-user";
  const privateFields = formatFields({ workspace: `${privateHome}/private-workspace`, cwd: `${privateHome}/private-workspace/subdir`, ordinary: "visible" });
  if (privateFields.includes(privateHome) || !privateFields.includes("<local-path>") || !privateFields.includes("visible")) {
    throw new Error("structured log local-path redaction failed");
  }
  const syntheticAwsKey = `AK${"IA"}${"A".repeat(16)}`;
  const sensitiveText = sanitizeLogText(`contact person@example.com at ${privateHome}/project ${syntheticAwsKey} abc\u202Etxt`);
  if (sensitiveText.includes("person@example.com") || sensitiveText.includes(privateHome) || sensitiveText.includes(syntheticAwsKey) || sensitiveText.includes("\u202E")) {
    throw new Error("free-form log privacy redaction failed");
  }
  const hostileFields = {};
  Object.defineProperty(hostileFields, "broken", { enumerable: true, get() { throw new Error("getter failed"); } });
  if (!formatFields(hostileFields).includes("fields_unavailable")) throw new Error("logging failed closed on hostile structured fields");
  const unprintable = { toString() { throw new Error("toString failed"); } };
  if (sanitizeLogText(unprintable) !== "<unprintable>") throw new Error("logging failed on an unprintable message");
  const oversizedFields = formatFields(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, "x".repeat(20_000)])));
  if (oversizedFields.length > 4500 || !oversizedFields.includes("fields_truncated")) throw new Error("structured log fields were not bounded");
}

async function serviceSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-service-test-"));
  try {
    const logs = join(stateRoot, "logs");
    await writeFile(join(stateRoot, "placeholder"), "", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(logs, { recursive: true }));
    const file = join(logs, "daemon.err.log");
    await writeFile(file, `${"discarded-line\n".repeat(300)}kept-unicode-日志\nlast-line\n`, "utf8");
    trimAutostartLogs(stateRoot, { maxBytes: 2048, keepBytes: 1024 });
    const trimmed = await readFile(file, "utf8");
    if ((await stat(file)).size > 1024 || trimmed.startsWith("�") || !trimmed.endsWith("last-line\n")) {
      throw new Error("autostart log tail trimming was not line/UTF-8 safe");
    }
    if (process.platform !== "win32") {
      const outsideTarget = join(stateRoot, "outside-log-target");
      const linkedLog = join(logs, "daemon.out.log");
      await writeFile(outsideTarget, "must-remain-unchanged", "utf8");
      try {
        await symlink(outsideTarget, linkedLog);
        trimAutostartLogs(stateRoot, { maxBytes: 1024, keepBytes: 1024 });
        if (await readFile(outsideTarget, "utf8") !== "must-remain-unchanged") {
          throw new Error("autostart log trimming followed a symbolic link");
        }
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      }
    }
    const nodeBin = join(stateRoot, "node-bin");
    await mkdir(nodeBin, { recursive: true });
    const nodeTarget = join(nodeBin, process.platform === "win32" ? "node-target.exe" : "node-target");
    const nodeAlias = join(nodeBin, process.platform === "win32" ? "node.exe" : "node");
    await writeFile(nodeTarget, "node-fixture", "utf8");
    if (process.platform !== "win32") {
      await chmod(nodeTarget, 0o755);
      await symlink(nodeTarget, nodeAlias);
      if (stableNodeExecutable({ execPath: nodeTarget, pathEnv: nodeBin }) !== nodeAlias) {
        throw new Error("autostart did not prefer a stable PATH alias for the active Node binary");
      }
    } else if (stableNodeExecutable({ execPath: nodeTarget, pathEnv: nodeBin }) !== nodeTarget) {
      throw new Error("autostart Node fallback changed the active Windows executable");
    }

    const quoted = systemdQuote("path with space/%value'\n");
    if (!quoted.startsWith('"') || !quoted.includes("%%") || !quoted.includes("\\n")) throw new Error("systemd argument quoting failed");
    const args = daemonArgs({ entryScript: "/package/bin/machine-mcp.mjs", workspace: "/workspace", stateRoot: "/state" });
    if (args.some((value) => ["--profile", "--exec-mode", "--no-write", "--full-env", "--unrestricted-paths", "--absolute-paths"].includes(value))) {
      throw new Error("autostart duplicated policy outside owner-only state");
    }
    const logLevelIndex = args.indexOf("--log-level");
    if (logLevelIndex < 0 || args[logLevelIndex + 1] !== "warn" || args.includes("--quiet")) {
      throw new Error("autostart did not retain warning/error logs without normal chatter");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function ciBootstrapSelfTest() {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const setupIndexes = lines.flatMap((line, index) => line.includes("uses: actions/setup-node@v6") ? [index] : []);
  if (setupIndexes.length !== 2) throw new Error("CI must contain exactly two setup-node bootstrap blocks");
  for (const index of setupIndexes) {
    const setupWindow = lines.slice(index, index + 6).join("\n");
    if (!setupWindow.includes("package-manager-cache: false")) {
      throw new Error("setup-node automatic package-manager cache must stay disabled until npm 12 is installed");
    }
  }
  const temporaryDirectoryCount = lines.filter((line) => line.includes("working-directory: ${{ runner.temp }}")).length;
  const npmUpgradeCount = lines.filter((line) => line.includes("npm install --global npm@12.0.1")).length;
  if (temporaryDirectoryCount !== 2 || npmUpgradeCount !== 2) {
    throw new Error("CI must bootstrap npm 12 from the runner temporary directory in both jobs");
  }
}

async function shellSelfTest() {
  const result = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096));"], {
    capture: true,
    maxOutputBytes: 1024,
  });
  if (result.code !== 0 || !result.stdout.includes("[truncated") || !result.stderr.includes("[truncated")) {
    throw new Error("bounded shell capture failed");
  }
  const timedOut = await run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    capture: true,
    allowFailure: true,
    timeoutMs: 50,
  });
  if (timedOut.code !== 124 || !timedOut.stderr.includes("timed out")) throw new Error("shell timeout handling failed");
}

async function workerSourceSelfTest() {
  const source = await readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8");
  const unawaitedAsyncRoutes = [
    "return this.registerClient(request);",
    "return this.authorizeSubmit(request, base);",
    "return this.exchangeToken(request, base);",
    "return this.acceptDaemonWebSocket(request);",
    "return this.handleMcp(request, base);",
  ].filter(snippet => source.includes(snippet));
  if (unawaitedAsyncRoutes.length) {
    throw new Error(`Worker async routes must be awaited so HttpError is caught: ${unawaitedAsyncRoutes.join(", ")}`);
  }
  for (const required of [
    "MAX_PENDING_CALLS",
    "MAX_DAEMON_MESSAGE_BYTES",
    "withOAuthLock",
    "oauthQueue",
    "AUTH_FAILURE_LIMIT",
    "OAUTH_BODY_LIMIT_BYTES",
    "pending.socket !== ws",
    "isJsonRpcId(candidate.id)",
    "pruneRecordByExpiry(store.tokens, MAX_OAUTH_TOKENS)",
    "A valid PKCE S256 challenge is required.",
    "hmac-sha256:",
    "DAEMON_HELLO_TIMEOUT_MS",
    "async alarm()",
    "storage.setAlarm",
    'role: "candidate"',
    'role: "expired"',
    "daemon_hello_timeout",
    "replaced by authenticated daemon",
    "serverMetadata.protocolVersion",
    "notifications/cancelled",
    "structuredContent",
    "../shared/tool-catalog.json",
  ]) {
    if (!source.includes(required)) throw new Error(`Worker hardening guard missing: ${required}`);
  }
  for (const removed of [
    "/api/mcp/sampling",
    "/api/daemon/status",
    "sampling/createMessage",
    'request.headers.get("User-Agent")',
  ]) {
    if (source.includes(removed)) throw new Error(`obsolete or public-sensitive Worker route remains: ${removed}`);
  }
}

async function existsForSelfTest(file) {
  try { await stat(file); return true; } catch { return false; }
}

function expectThrow(callback, pattern) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}
