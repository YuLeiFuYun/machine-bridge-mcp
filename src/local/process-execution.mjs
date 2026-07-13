import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";
import { MAX_COMMAND_BYTES, terminateProcessTreeWithEscalation, validateArgv } from "./process-sessions.mjs";
import { BridgeError } from "./errors.mjs";
import { clampInteger } from "./numbers.mjs";

const MAX_STDIN_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 512 * 1024;

export class ProcessExecutionService {
  constructor({ workspace, policy, policyGate, runtimeDir, processTracker, resolveExistingPath, resolveLocalCommand, displayPath, throwIfCancelled }) {
    this.workspace = workspace;
    this.policy = policy;
    this.policyGate = policyGate;
    this.runtimeDir = runtimeDir;
    this.processTracker = processTracker;
    this.resolveExistingPath = resolveExistingPath;
    this.resolveLocalCommand = resolveLocalCommand;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
  }

  async runDirect(args, context = {}) {
    this.policyGate.assert("run_process");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveExistingPath(args.cwd || ".");
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "cwd is not a directory");
    return this.run(argv[0], argv.slice(1), clampInteger(args.timeout_seconds, 120, 1, 600) * 1000, false, DEFAULT_OUTPUT_BYTES, context, cwd);
  }

  async runRegistered(args, context = {}) {
    this.policyGate.assert("run_local_command");
    const command = await this.resolveLocalCommand(args, context);
    const argv = validateArgv(command.argv);
    const cwd = await this.resolveExistingPath(command.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "registered command cwd is not a directory");
    const requested = args.timeout_seconds === undefined
      ? command.timeoutSeconds
      : clampInteger(args.timeout_seconds, command.timeoutSeconds, 1, 600);
    const timeoutSeconds = Math.min(requested, command.timeoutSeconds);
    const result = await this.run(argv[0], argv.slice(1), timeoutSeconds * 1000, false, DEFAULT_OUTPUT_BYTES, context, cwd);
    return { name: command.name, cwd: this.displayPath(cwd), timeout_seconds: timeoutSeconds, ...result };
  }

  async probeShell(context = {}) {
    const shell = workspaceShellCommand(process.platform === "win32" ? "cd" : "pwd");
    return this.run(shell.cmd, shell.args, 5000, true, 64 * 1024, context);
  }

  async runShell(command, timeoutSeconds, context = {}) {
    this.policyGate.assert("exec_command");
    if (!command || typeof command !== "string") throw new BridgeError("invalid_request", "command is required");
    if (command.includes("\0")) throw new BridgeError("invalid_request", "command contains a NUL byte");
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new BridgeError("limit_exceeded", `command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
    const shell = workspaceShellCommand(command);
    return this.run(shell.cmd, shell.args, clampInteger(timeoutSeconds, 120, 1, 600) * 1000, false, DEFAULT_OUTPUT_BYTES, context);
  }

  terminateAll(signal = "SIGTERM", escalate = false) {
    this.processTracker.terminateAll(signal, escalate);
  }

  async run(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = DEFAULT_OUTPUT_BYTES, context = {}, cwd = this.workspace, stdin = null) {
    this.throwIfCancelled(context);
    if (stdin !== null && Buffer.byteLength(String(stdin)) > MAX_STDIN_BYTES) {
      throw new BridgeError("limit_exceeded", "process stdin exceeds 1 MiB");
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(cmd, args, {
        cwd,
        env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false, runtimeDir: this.runtimeDir }),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.processTracker.track(child, context.callId);
      if (stdin !== null) {
        child.stdin.on("error", () => {});
        child.stdin.end(String(stdin));
      }
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = 0;
      let stderrTruncated = 0;
      let timedOut = false;
      let settled = false;
      let killTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        killTimer = terminateProcessTreeWithEscalation(child);
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer && !timedOut) clearTimeout(killTimer);
        this.processTracker.untrack(child);
      };
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      child.stdout.on("data", (chunk) => {
        const next = appendLimited(stdout, chunk, maxOutputBytes);
        stdout = next.value;
        stdoutTruncated += next.truncated;
      });
      child.stderr.on("data", (chunk) => {
        const next = appendLimited(stderr, chunk, maxOutputBytes);
        stderr = next.value;
        stderrTruncated += next.truncated;
      });
      child.on("error", (error) => finish(() => {
        if (allowFailure) resolvePromise({ code: 127, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: boundedErrorMessage(error) });
        else rejectPromise(error);
      }));
      child.on("close", (code) => finish(() => {
        const result = { code, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: finalizeOutput(stderr, stderrTruncated) };
        try { this.throwIfCancelled(context); } catch (error) { rejectPromise(error); return; }
        if (timedOut) {
          rejectPromise(new BridgeError("timeout", `command timed out after ${timeoutMs}ms`, { retryable: true }));
          return;
        }
        if (code === 0 || allowFailure) resolvePromise(result);
        else rejectPromise(new BridgeError("execution_failed", stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
      }));
    });
  }
}

export function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "tool call failed";
}

function appendLimited(current, chunk, maximum) {
  const text = String(chunk || "");
  const budget = Math.max(0, maximum - Buffer.byteLength(current));
  const textBytes = Buffer.byteLength(text);
  if (textBytes <= budget) return { value: current + text, truncated: 0 };
  const slice = Buffer.from(text).subarray(0, budget).toString();
  return { value: current + slice, truncated: textBytes - Buffer.byteLength(slice) };
}

function finalizeOutput(value, truncated) {
  return truncated > 0 ? `${value}\n\n[truncated ${truncated} bytes]` : value;
}
