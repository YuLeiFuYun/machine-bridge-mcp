import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./state.mjs";
import { BoundedOutput } from "./bounded-output.mjs";

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const capture = Boolean(options.capture);
    const maxOutputBytes = Number.isFinite(Number(options.maxOutputBytes)) ? Math.max(1024, Number(options.maxOutputBytes)) : 2 * 1024 * 1024;
    const child = spawn(command, args, {
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
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const timeoutMs = Number(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateCommandTree(child, false);
        killTimer = setTimeout(() => terminateCommandTree(child, true), 2000);
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
    child.on("error", error => finish(() => {
      const result = capturedResult(127, stdout, stderr, error.message);
      if (options.allowFailure) resolve(result);
      else reject(error);
    }));
    child.on("close", code => finish(() => {
      const timeoutMessage = timedOut ? `command timed out after ${timeoutMs}ms` : "";
      const result = {
        ...capturedResult(timedOut ? 124 : code, stdout, stderr, timeoutMessage),
      };
      if ((!timedOut && code === 0) || options.allowFailure) resolve(result);
      else {
        const error = new Error((result.stderr || result.stdout || `${command} exited ${result.code}`).trim());
        error.result = result;
        reject(error);
      }
    }));
  });
}


function terminateCommandTree(child, force) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    } catch {}
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch {}
  }
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

function findWranglerCommand() {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(packageRoot, "node_modules", ".bin", `wrangler${suffix}`);
  if (existsSync(local)) return { cmd: local, argsPrefix: [] };
  throw new Error("Wrangler dependency is not installed. Run `npm install` in the package/source directory and retry.");
}

export async function runWrangler(args, options = {}) {
  const wrangler = findWranglerCommand();
  const operation = String(args[0] || "");
  const timeoutMs = options.timeoutMs ?? (operation === "login" || operation === "deploy" ? 10 * 60 * 1000 : 2 * 60 * 1000);
  return run(wrangler.cmd, [...wrangler.argsPrefix, ...args], { cwd: packageRoot, timeoutMs, ...options });
}

export function workspaceShellCommand(command) {
  if (process.platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  const shell = process.env.MBM_EXEC_SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
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
