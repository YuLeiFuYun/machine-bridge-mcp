import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entry = resolve(root, "bin", "machine-mcp.mjs");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const version = run(["version"]);
assert(version.status === 0, `version command failed: ${version.stderr}`);
assert(version.stdout.trim() === `${pkg.name} ${pkg.version}`, "version command returned stale package metadata");

const versionFlag = run(["--version"]);
assert(versionFlag.status === 0 && versionFlag.stdout.trim() === `${pkg.name} ${pkg.version}`, "--version did not use default-command normalization");

const help = run(["help"]);
assert(help.status === 0, `help command failed: ${help.stderr}`);
assert(help.stdout.includes("Usage:") && help.stdout.includes("--log-format"), "help output omitted current CLI options");
assert(help.stdout.includes("newly generated account passwords are included once"), "help output incorrectly claims JSON can never contain a generated password");

const stateRoot = mkdtempSync(join(tmpdir(), "mbm-cli-entrypoint-state-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "mbm-cli-entrypoint-workspace-"));
try {
  const initial = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(initial.status === 0, `workspace show failed: ${initial.stderr}`);
  assert(initial.stdout.includes("No workspace selected yet"), "workspace show returned an unexpected initial state");

  const selected = run(["workspace", "set", workspaceRoot, "--state-dir", stateRoot]);
  assert(selected.status === 0 && selected.stdout.includes("Selected workspace:"), `workspace set failed: ${selected.stderr}`);
  const persistedConfig = JSON.parse(readFileSync(join(stateRoot, "config.json"), "utf8"));
  const persistedWorkspace = String(persistedConfig.selectedWorkspace || "");
  assert(
    normalizePathText(persistedWorkspace) === normalizePathText(realpathSync.native ? realpathSync.native(workspaceRoot) : realpathSync(workspaceRoot)),
    "workspace selection config did not contain the canonical workspace",
  );
  const remembered = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(
    remembered.status === 0 && normalizePathText(remembered.stdout.trim()) === normalizePathText(persistedWorkspace),
    "workspace show did not return the persisted selection",
  );

  const status = run(["status", "--workspace", workspaceRoot, "--state-dir", stateRoot]);
  assert(status.status === 0, `status command failed without a Worker: ${status.stderr}`);
  const statusPayload = JSON.parse(status.stdout);
  assert(statusPayload.workerHealth.error === "no worker url", "status did not report the missing Worker deterministically");

  const clientConfig = run(["client-config", "codex", "--workspace", workspaceRoot, "--state-dir", stateRoot]);
  assert(clientConfig.status === 0 && clientConfig.stdout.includes("[mcp_servers.machine_bridge]"), `client-config failed: ${clientConfig.stderr}`);

  const reset = run(["workspace", "reset", "--state-dir", stateRoot]);
  assert(reset.status === 0 && reset.stdout.includes("selection reset"), `workspace reset failed: ${reset.stderr}`);
  const afterReset = run(["workspace", "show", "--state-dir", stateRoot]);
  assert(afterReset.stdout.includes("No workspace selected yet"), "workspace reset did not clear the selection");

  const unknown = run(["not-a-command"]);
  assert(unknown.status === 2 && unknown.stderr.includes("Unknown command"), "unknown command did not return the documented usage error");
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log("CLI entrypoint test ok");

function normalizePathText(value) {
  return String(value).split("\\").join("/").toLowerCase();
}

function run(args) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
