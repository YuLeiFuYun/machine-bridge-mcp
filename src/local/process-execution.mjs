import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { BoundedOutput } from "./bounded-output.mjs";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";
import { MAX_COMMAND_BYTES, validateArgv } from "./process-contract.mjs";
import { terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { BridgeError } from "./errors.mjs";
import { clampInteger } from "./numbers.mjs";
import {
  DEFAULT_PROCESS_OUTPUT_BYTES, MAX_PROCESS_STDIN_BYTES, MAX_PROCESS_TIMEOUT_SECONDS, MIN_PROCESS_TIMEOUT_SECONDS,
} from "./execution-limits.mjs";

function spawnDirectProcess(command, args, options) {
  // Keep the production child_process API call structurally separate from the
  // injectable test seam and enforce non-shell execution at the final boundary.
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    windowsHide: options.windowsHide,
    shell: false,
  });
}

export class ProcessExecutionService {
  constructor({ workspace, policy, policyGate, runtimeDir, processTracker, resolveExistingPath, resolveLocalCommand, displayPath, throwIfCancelled, spawnProcess = spawnDirectProcess, terminateProcess = terminateProcessTreeWithEscalation }) {
    this.workspace = workspace;
    this.policy = policy;
    this.policyGate = policyGate;
    this.runtimeDir = runtimeDir;
    this.processTracker = processTracker;
    this.resolveExistingPath = resolveExistingPath;
    this.resolveLocalCommand = resolveLocalCommand;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;
  }

  async runDirect(args, context = {}) {
    this.policyGate.assert("run_process");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveExistingPath(args.cwd || ".");
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "cwd is not a directory");
    return this.run(argv[0], argv.slice(1), clampInteger(args.timeout_seconds, 120, MIN_PROCESS_TIMEOUT_SECONDS, MAX_PROCESS_TIMEOUT_SECONDS) * 1000, false, DEFAULT_PROCESS_OUTPUT_BYTES, context, cwd);
  }

  async runRegistered(args, context = {}) {
    this.policyGate.assert("run_local_command");
    const command = await this.resolveLocalCommand(args, context);
    const argv = validateArgv(command.argv);
    const cwd = await this.resolveExistingPath(command.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "registered command cwd is not a directory");
    const requested = args.timeout_seconds === undefined
      ? command.timeoutSeconds
      : clampInteger(args.timeout_seconds, command.timeoutSeconds, MIN_PROCESS_TIMEOUT_SECONDS, MAX_PROCESS_TIMEOUT_SECONDS);
    const timeoutSeconds = Math.min(requested, command.timeoutSeconds);
    const result = await this.run(argv[0], argv.slice(1), timeoutSeconds * 1000, false, DEFAULT_PROCESS_OUTPUT_BYTES, context, cwd);
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
    return this.run(shell.cmd, shell.args, clampInteger(timeoutSeconds, 120, MIN_PROCESS_TIMEOUT_SECONDS, MAX_PROCESS_TIMEOUT_SECONDS) * 1000, false, DEFAULT_PROCESS_OUTPUT_BYTES, context);
  }

  terminateAll(signal = "SIGTERM", escalate = false) {
    this.processTracker.terminateAll(signal, escalate);
  }

  async run(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES, context = {}, cwd = this.workspace, stdin = null) {
    this.throwIfCancelled(context);
    if (stdin !== null && Buffer.byteLength(String(stdin)) > MAX_PROCESS_STDIN_BYTES) {
      throw new BridgeError("limit_exceeded", "process stdin exceeds 1 MiB");
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const stdout = new BoundedOutput(maxOutputBytes);
      const stderr = new BoundedOutput(maxOutputBytes);
      let child;
      try {
        child = this.spawnProcess(cmd, args, {
          cwd,
          env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false, runtimeDir: this.runtimeDir }),
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }

      this.processTracker.track(child, context.callId);
      if (stdin !== null) {
        child.stdin?.on?.("error", () => {});
        child.stdin?.end?.(String(stdin));
      }

      let settled = false;
      let processClosed = false;
      let terminationTimer = null;
      let timeoutTimer = null;
      const signal = context.signal;

      const cleanupAfterClose = () => {
        if (processClosed) return;
        processClosed = true;
        clearTimeout(timeoutTimer);
        signal?.removeEventListener?.("abort", onAbort);
        this.processTracker.untrack(child);
      };

      const settle = (callback) => {
        if (settled) return false;
        settled = true;
        callback();
        return true;
      };

      const terminate = () => {
        if (terminationTimer || processClosed) return;
        terminationTimer = this.terminateProcess(child);
      };

      const rejectCancelled = () => {
        terminate();
        const reason = signal?.reason;
        settle(() => rejectPromise(reason instanceof Error ? reason : new BridgeError("cancelled", "tool call cancelled")));
      };

      const onAbort = () => rejectCancelled();
      signal?.addEventListener?.("abort", onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        terminate();
        settle(() => rejectPromise(new BridgeError("timeout", `command timed out after ${timeoutMs}ms`, { retryable: true })));
      }, timeoutMs);
      timeoutTimer.unref?.();

      child.stdout?.on?.("data", (chunk) => stdout.append(chunk));
      child.stderr?.on?.("data", (chunk) => stderr.append(chunk));

      child.on("error", (error) => {
        cleanupAfterClose();
        settle(() => {
          if (allowFailure) resolvePromise(processResult(127, stdout, error.message || stderr.text()));
          else rejectPromise(error);
        });
      });

      child.on("close", (code) => {
        cleanupAfterClose();
        if (settled) return;
        try { this.throwIfCancelled(context); } catch (error) {
          settle(() => rejectPromise(error));
          return;
        }
        const result = processResult(code, stdout, stderr);
        if (code === 0 || allowFailure) settle(() => resolvePromise(result));
        else settle(() => rejectPromise(new BridgeError("execution_failed", result.stderr.trim() || result.stdout.trim() || `${cmd} exited ${code}`)));
      });

      if (signal?.aborted) rejectCancelled();
    });
  }
}

function processResult(code, stdout, stderr) {
  const stderrBuffer = stderr instanceof BoundedOutput ? stderr : null;
  return {
    code,
    stdout: stdout instanceof BoundedOutput ? stdout.text() : String(stdout || ""),
    stderr: stderrBuffer ? stderrBuffer.text() : boundedErrorMessage(stderr),
    stdout_truncated_bytes: stdout instanceof BoundedOutput ? stdout.truncatedBytes : 0,
    stderr_truncated_bytes: stderrBuffer ? stderrBuffer.truncatedBytes : 0,
  };
}

export function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "tool call failed";
}
