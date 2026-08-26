import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./package-identity.mjs";
import { ensureWranglerToolchain } from "./wrangler-toolchain.mjs";
import { BoundedOutput } from "./bounded-output.mjs";
import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-tree.mjs";

export function runExecutable(command, args = [], options = {}) {
  const executable = validateExecutable(command);
  const argv = validateExecutableArgs(args);
  return new Promise((resolve, reject) => {
    const capture = Boolean(options.capture);
    const maxOutputBytes = Number.isFinite(Number(options.maxOutputBytes)) ? Math.max(1024, Number(options.maxOutputBytes)) : 2 * 1024 * 1024;
    const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
    const child = spawnProcess(executable, argv, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout = new BoundedOutput(maxOutputBytes);
    const stderr = new BoundedOutput(maxOutputBytes);
    let settled = false;
    let timedOut = false; let childError = null;
    let timer = null;
    let killTimer = null;
    const timeoutMs = Number(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (options.hardTimeout === true) terminateProcessTree(child, "SIGKILL");
        else killTimer = terminateProcessTreeWithEscalation(child);
      }, timeoutMs);
      timer.unref?.();
    }
    const finish = callback => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer && !timedOut) clearTimeout(killTimer);
      callback();
    };
    if (capture) {
      child.stdout?.on("data", chunk => stdout.append(chunk));
      child.stderr?.on("data", chunk => stderr.append(chunk));
    }
    child.on("error", error => { childError ||= error; });
    child.on("close", code => finish(() => {
      const failureMessage = timedOut ? `command timed out after ${timeoutMs}ms` : childError?.message || "";
      const result = {
        ...capturedResult(timedOut ? 124 : childError ? 127 : code, stdout, stderr, failureMessage),
        timed_out: timedOut,
      };
      if ((!timedOut && !childError && code === 0) || options.allowFailure) resolve(result);
      else if (childError && !timedOut) reject(childError);
      else {
        const error = new Error((result.stderr || result.stdout || `${executable} exited ${result.code}`).trim());
        error.result = result;
        reject(error);
      }
    }));
  });
}


function validateExecutable(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new TypeError("executable must be a non-empty string without NUL bytes");
  }
  if (Buffer.byteLength(value) > 32 * 1024) throw new RangeError("executable path exceeds 32 KiB");
  return value;
}

function validateExecutableArgs(value) {
  if (!Array.isArray(value) || value.length > 4096) throw new TypeError("executable arguments must be an array with at most 4096 entries");
  let totalBytes = 0;
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.includes("\0")) throw new TypeError("executable arguments must be strings without NUL bytes");
    totalBytes += Buffer.byteLength(entry);
    if (totalBytes > 1024 * 1024) throw new RangeError("executable arguments exceed 1 MiB");
    return entry;
  });
}


function capturedResult(code, stdout, stderr, extraStderr = "") {
  const stderrText = [stderr.text(), extraStderr].filter(Boolean).join("\n");
  return {
    code,
    stdout: stdout.text(),
    stderr: stderrText,
    stdout_truncated_bytes: stdout.truncatedBytes,
    stderr_truncated_bytes: stderr.truncatedBytes,
  };
}

export function wranglerCommand(options = {}) {
  const root = realpathSync(path.resolve(String(options.packageRoot || packageRoot)));
  const node = path.resolve(String(options.node || process.execPath));
  const script = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  let info;
  try { info = lstatSync(script); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Wrangler JavaScript entrypoint is missing: ${script}`, { cause: error });
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1 || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)) {
    throw new Error("Wrangler JavaScript entrypoint must be a private real regular file");
  }
  const canonical = realpathSync(script);
  const relative = path.relative(root, canonical);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Wrangler JavaScript entrypoint escapes the private toolchain root");
  }
  return { cmd: node, argsPrefix: [canonical] };
}

export async function runWrangler(args, options = {}) {
  const toolchainRoot = await ensureWranglerToolchain({
    stateRoot: options.stateRoot,
    packageRoot: options.packageRoot || packageRoot,
    npmCli: options.npmCli,
    env: options.env || process.env,
    runCommand: options.runCommand || runExecutable,
    auditMaxAgeMs: options.auditMaxAgeMs,
    hardenedNpm: options.hardenedNpm,
  });
  const wrangler = wranglerCommand({ packageRoot: toolchainRoot, node: options.node });
  const operation = String(args[0] || "");
  const timeoutMs = options.timeoutMs ?? (operation === "login" || operation === "deploy" ? 10 * 60 * 1000 : 2 * 60 * 1000);
  const { stateRoot: _stateRoot, packageRoot: _packageRoot, npmCli: _npmCli, runCommand: _runCommand, auditMaxAgeMs: _auditMaxAgeMs, hardenedNpm: _hardenedNpm, node: _node, ...executionOptions } = options;
  return runExecutable(wrangler.cmd, [...wrangler.argsPrefix, ...args], { cwd: packageRoot, timeoutMs, ...executionOptions });
}

export function workspaceShellCommand(command) {
  if (process.platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  const shell = existsSync("/bin/zsh") ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const base = path.basename(shell);
  if (base === "zsh") return { cmd: shell, args: ["-f", "-c", command] };
  if (base === "bash") return { cmd: shell, args: ["--noprofile", "--norc", "-c", command] };
  return { cmd: shell, args: ["-c", command] };
}

export function executionEnv(workspace, options = {}) {
  // Minimal mode deliberately replaces user home/temp/cache locations so common
  // toolchains do not inherit credential-bearing configuration by accident.
  if (options.fullEnv || process.env.MBM_PASS_ENV === "true") return { ...process.env, MBM_WORKSPACE: workspace };
  const runtimeDir = options.runtimeDir ? path.resolve(String(options.runtimeDir)) : "";
  if (!runtimeDir) throw new Error("minimal execution environment requires a runtime directory");
  const runtimeHome = path.join(runtimeDir, "home");
  const runtimeTmp = path.join(runtimeDir, "tmp");
  const runtimeCache = path.join(runtimeDir, "cache");
  const env = {
    MBM_WORKSPACE: workspace,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    TMPDIR: runtimeTmp,
    TMP: runtimeTmp,
    TEMP: runtimeTmp,
    XDG_CACHE_HOME: runtimeCache,
    npm_config_cache: path.join(runtimeCache, "npm"),
    PIP_CACHE_DIR: path.join(runtimeCache, "pip"),
    CARGO_HOME: path.join(runtimeCache, "cargo"),
  };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (!env.PATH) env.PATH = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}
