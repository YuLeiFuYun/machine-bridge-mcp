import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./state.mjs";

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.on("data", chunk => { stdout += String(chunk); });
      child.stderr?.on("data", chunk => { stderr += String(chunk); });
    }
    child.on("error", error => {
      if (options.allowFailure) resolve({ code: 127, stdout, stderr: error.message });
      else reject(error);
    });
    child.on("close", code => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(result);
      else {
        const error = new Error((stderr || stdout || `${command} exited ${code}`).trim());
        error.result = result;
        reject(error);
      }
    });
  });
}

export function findWranglerCommand() {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(packageRoot, "node_modules", ".bin", `wrangler${suffix}`);
  if (existsSync(local)) return { cmd: local, argsPrefix: [] };
  return { cmd: "npx", argsPrefix: ["wrangler"] };
}

export async function runWrangler(args, options = {}) {
  const wrangler = findWranglerCommand();
  return run(wrangler.cmd, [...wrangler.argsPrefix, ...args], { cwd: packageRoot, ...options });
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
  // Keep environment small to avoid accidental dependence on the launching shell,
  // but do not hide filesystem contents. Operators can opt into full env when desired.
  if (options.fullEnv || process.env.MBM_PASS_ENV === "true") return { ...process.env, MBM_WORKSPACE: workspace };
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"];
  const env = { MBM_WORKSPACE: workspace };
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  if (!env.PATH) env.PATH = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}
