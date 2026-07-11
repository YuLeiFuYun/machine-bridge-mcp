import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./state.mjs";

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const capture = Boolean(options.capture);
    const maxOutputBytes = Number.isFinite(Number(options.maxOutputBytes)) ? Math.max(1024, Number(options.maxOutputBytes)) : 2 * 1024 * 1024;
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = 0;
    let stderrTruncated = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const timeoutMs = Number(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
    const finish = callback => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      callback();
    };
    if (capture) {
      child.stdout?.on("data", chunk => {
        const next = appendLimited(stdout, chunk, maxOutputBytes);
        stdout = next.value;
        stdoutTruncated += next.truncated;
      });
      child.stderr?.on("data", chunk => {
        const next = appendLimited(stderr, chunk, maxOutputBytes);
        stderr = next.value;
        stderrTruncated += next.truncated;
      });
    }
    child.on("error", error => finish(() => {
      const result = { code: 127, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: finalizeOutput(error.message || stderr, stderrTruncated) };
      if (options.allowFailure) resolve(result);
      else reject(error);
    }));
    child.on("close", code => finish(() => {
      const timeoutMessage = timedOut ? `command timed out after ${timeoutMs}ms` : "";
      const result = {
        code: timedOut ? 124 : code,
        stdout: finalizeOutput(stdout, stdoutTruncated),
        stderr: finalizeOutput([stderr, timeoutMessage].filter(Boolean).join("\n"), stderrTruncated),
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

function appendLimited(current, chunk, max) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
  const budget = Math.max(0, max - Buffer.byteLength(current));
  if (buffer.length <= budget) return { value: current + buffer.toString("utf8"), truncated: 0 };
  const slice = buffer.subarray(0, budget).toString("utf8");
  return { value: current + slice, truncated: buffer.length - Buffer.byteLength(slice) };
}

function finalizeOutput(value, truncated) {
  return truncated > 0 ? `${value}\n\n[truncated ${truncated} bytes]` : value;
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
