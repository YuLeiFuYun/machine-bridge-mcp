import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.mjs";

const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let macosProbeResult;

export function delegatedProcessCommand({ command, args = [], workspace, runtimeDir, context = {}, platform = process.platform, forceDelegated = false } = {}) {
  const principal = context?.authority?.principal;
  if (!forceDelegated && (!principal || principal.kind !== "account" || principal.role === "owner")) {
    return { command, args, isolation: "owner-or-local-user" };
  }
  if (platform === "darwin" && macosSandboxAvailable({ platform })) {
    const profile = macosProfile({ workspace, runtimeDir });
    return {
      command: MACOS_SANDBOX_EXEC,
      args: ["-p", profile, String(command), ...args.map(String)],
      isolation: "macos-sandbox-exec-workspace",
    };
  }
  throw new BridgeError(
    "policy_denied",
    "delegated process execution requires a behavior-verified OS workspace sandbox; use the owner account or an isolated worker account/VM",
    { details: { reason: "delegated_process_isolation_unavailable", platform } },
  );
}

export function delegatedProcessIsolationStatus(platform = process.platform) {
  if (platform === "darwin" && macosSandboxAvailable({ platform })) {
    return {
      available: true,
      provider: "macos-sandbox-exec-deny-default",
      network: "allowed",
      filesystem: "workspace-and-runtime-write; system-runtime-read",
      keychain: "common Keychain CLI access denied by the behavior probe; not a complete same-user tenancy boundary",
      apple_events: "not reachable through the deny-default profile",
      residual: "sandbox-exec is a compatibility boundary, not separate OS-user tenancy; choose a narrow workspace",
    };
  }
  return {
    available: false,
    provider: null,
    network: "unavailable",
    filesystem: "unavailable",
    keychain: "unavailable",
    apple_events: "unavailable",
    residual: platform === "darwin"
      ? "sandbox-exec exists but the workspace read/write, outside-path denial, or Keychain-denial behavior probe failed; delegated execution fails closed"
      : "no verified delegated process sandbox provider is installed; delegated execution fails closed",
  };
}

export function macosDelegatedSandboxProfile({ workspace, runtimeDir } = {}) {
  return macosProfile({ workspace, runtimeDir });
}

export function macosSandboxAvailable(options = {}) {
  if (options.refresh === true) macosProbeResult = undefined;
  if (macosProbeResult !== undefined) return macosProbeResult;
  const platform = String(options.platform || process.platform);
  const exists = typeof options.exists === "function" ? options.exists : existsSync;
  if (platform !== "darwin" || !exists(MACOS_SANDBOX_EXEC)) {
    macosProbeResult = false;
    return false;
  }
  const probe = typeof options.behaviorProbe === "function" ? options.behaviorProbe : probeMacosDelegatedSandbox;
  macosProbeResult = probe({ spawnSyncProcess: options.spawnSync || spawnSync }) === true;
  return macosProbeResult;
}

export function probeMacosDelegatedSandbox(options = {}) {
  const run = typeof options.spawnSyncProcess === "function" ? options.spawnSyncProcess : spawnSync;
  const root = mkdtempSync(path.join(tmpdir(), "mbm-delegated-sandbox-probe-"));
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const outside = path.join(root, "outside.txt");
  const outsideWrite = path.join(root, "outside-write.txt");
  const workspaceWrite = path.join(workspace, "allowed-write.txt");
  try {
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(runtimeDir, { mode: 0o700 });
    writeFileSync(path.join(workspace, "allowed.txt"), "allowed\n", { mode: 0o600 });
    writeFileSync(outside, "blocked\n", { mode: 0o600 });
    const profile = macosProfile({ workspace, runtimeDir });
    const execute = (argv) => run(MACOS_SANDBOX_EXEC, ["-p", profile, ...argv], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: workspace, TMPDIR: runtimeDir, LANG: "C", LC_ALL: "C" },
    });
    const allowedRead = execute(["/bin/cat", path.join(workspace, "allowed.txt")]);
    const allowedWrite = execute(["/bin/sh", "-c", `printf allowed > ${shellQuote(workspaceWrite)}`]);
    const blockedRead = execute(["/bin/cat", outside]);
    const blockedWrite = execute(["/bin/sh", "-c", `printf blocked > ${shellQuote(outsideWrite)}`]);
    const keychain = execute(["/usr/bin/security", "list-keychains"]);
    return allowedRead.status === 0 && allowedWrite.status === 0 && existsSync(workspaceWrite)
      && blockedRead.status !== 0 && blockedWrite.status !== 0 && !existsSync(outsideWrite)
      && keychain.status !== 0;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function macosProfile({ workspace, runtimeDir }) {
  const readable = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/Applications",
    "/opt/homebrew",
    "/nix/store",
    "/private/etc",
    "/private/var/db",
    "/dev",
    workspace,
    runtimeDir,
  ].filter(Boolean);
  const writable = [workspace, runtimeDir, "/private/tmp"].filter(Boolean);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow network*)",
    "(allow file-read-metadata)",
    ...readable.map((value) => `(allow file-read* (subpath ${sandboxString(path.resolve(value))}))`),
    ...writable.map((value) => `(allow file-write* (subpath ${sandboxString(path.resolve(value))}))`),
  ].join(" ");
}

function sandboxString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
