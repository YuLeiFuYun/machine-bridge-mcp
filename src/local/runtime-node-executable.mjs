import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export function resolveRuntimeNodeExecutable({
  execPath = process.execPath,
  argv0 = process.argv0,
  platform = process.platform,
  isExecutable = null,
} = {}) {
  const executable = typeof isExecutable === "function"
    ? (candidate) => safeExecutableCheck(isExecutable, candidate)
    : (candidate) => executableFile(candidate, platform);
  const execPathAvailable = absoluteCandidate(execPath, platform) && executable(execPath);
  const launcherAvailable = trustedOriginalNodeLauncher(argv0, platform) && executable(argv0);
  if (execPathAvailable) return {
    available: true, command: execPath, source: "exec_path", exec_path_available: true,
    original_launcher_available: launcherAvailable, fallback_active: false,
  };
  if (launcherAvailable) return {
    available: true, command: argv0, source: "original_launcher", exec_path_available: false,
    original_launcher_available: true, fallback_active: true,
  };
  return {
    available: false, command: null, source: "unavailable", exec_path_available: false,
    original_launcher_available: false, fallback_active: false,
  };
}

export function runtimeNodeExecutableCheck(runtimeNode) {
  return {
    layer: "runtime-node-executable",
    ok: runtimeNode.available,
    source: runtimeNode.source,
    exec_path_available: runtimeNode.exec_path_available,
    original_launcher_available: runtimeNode.original_launcher_available,
    fallback_active: runtimeNode.fallback_active,
    error_class: runtimeNode.available ? null : "not_found",
  };
}

export async function runtimeNodeProcessCheck({
  runtimeNode, runFixedInternal, timeoutMs, context, workspace, classifyError,
}) {
  if (!runtimeNode.available) return {
    layer: "local-process-spawn", ok: false, error_class: "not_found",
    runtime_executable_source: runtimeNode.source,
  };
  const direct = await runFixedInternal(
    runtimeNode.command, ["-e", "process.stdout.write('ok')"], timeoutMs, true, 1024, context, workspace,
  ).catch((error) => ({ code: 127, stdout: "", stderr: "", error_class: classifyError(error) }));
  return {
    layer: "local-process-spawn",
    ok: direct.code === 0 && direct.stdout === "ok",
    runtime_executable_source: runtimeNode.source,
    error_class: direct.error_class
      || (direct.code === 0 ? null : classifyError(direct.stderr || direct.stdout || "execution failed")),
  };
}

function absoluteCandidate(value, platform) {
  return typeof value === "string" && value.length > 0 && pathApi(platform).isAbsolute(value);
}

function trustedOriginalNodeLauncher(value, platform) {
  if (!absoluteCandidate(value, platform)) return false;
  const name = pathApi(platform).basename(value).toLowerCase();
  return name === "node" || name === "node.exe";
}

function executableFile(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function safeExecutableCheck(check, candidate) {
  try { return check(candidate) === true; } catch { return false; }
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}
