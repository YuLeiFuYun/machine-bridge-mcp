import { spawn } from "node:child_process";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { BoundedOutput } from "./bounded-output.mjs";
import { attachChildProcessSettlement } from "./child-process-settlement.mjs";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";
import { MAX_COMMAND_BYTES, validateArgv } from "./process-contract.mjs";
import { terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { BridgeError } from "./errors.mjs";
import { delegatedProcessCommand } from "./delegated-process-sandbox.mjs";
import { ProcessOutputStream } from "./process-output-stream.mjs";
import { processForegroundTimeoutSeconds, registeredCommandTimeoutSeconds } from "./process-foreground-timeout.mjs";
import { processFailureMessage, publicProcessToolResult } from "./process-result-projection.mjs";
import { acquireProcessResources, bindProcessResources, releaseProcessResources, releaseProcessResourcesQuietly } from "./resource-process-admission.mjs";
import { DEFAULT_PROCESS_OUTPUT_BYTES, MAX_PROCESS_SESSION_OUTPUT_BYTES, MAX_PROCESS_STDIN_BYTES, PROCESS_SESSION_RETENTION_MS, PUBLIC_PROCESS_INLINE_OUTPUT_BYTES } from "./execution-limits.mjs";
const PROCESS_OUTPUT_CAPTURE = Symbol("process-output-capture"); const CONTINUATION_READ_BYTES = 64 * 1024;
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
  constructor({ workspace, policy, policyGate, policyForContext = null, runtimeDir, processTracker, resourceCoordinator = null, resourceWaitMs = 2_000, resolveExistingPath, resolveLocalCommand, displayPath, throwIfCancelled, retainCompletedOutput = null, spawnProcess = spawnDirectProcess, terminateProcess = terminateProcessTreeWithEscalation, childSettlementOptions = {} }) {
    this.workspace = workspace;
    this.policy = policy;
    this.policyGate = policyGate;
    this.policyForContext = typeof policyForContext === "function" ? policyForContext : () => this.policy;
    this.runtimeDir = runtimeDir;
    this.processTracker = processTracker;
    this.resourceCoordinator = resourceCoordinator;
    this.resourceWaitMs = resourceWaitMs;
    this.resolveExistingPath = resolveExistingPath;
    this.resolveLocalCommand = resolveLocalCommand;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
    this.retainCompletedOutput = typeof retainCompletedOutput === "function" ? retainCompletedOutput : null;
    this.spawnProcess = spawnProcess; this.terminateProcess = terminateProcess; this.childSettlementOptions = childSettlementOptions;
  }
  async runDirect(args, context = {}) {
    this.policyGate.assert("run_process");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveExistingPath(args.cwd || ".", context);
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "cwd is not a directory");
    const timeoutSeconds = processForegroundTimeoutSeconds("run_process", args.timeout_seconds, context);
    const result = await this.runPublic(
      argv[0], argv.slice(1), timeoutSeconds * 1000,
      context, cwd,
    );
    return publicProcessToolResult(result);
  }
  async runRegistered(args, context = {}) {
    this.policyGate.assert("run_local_command");
    const command = await this.resolveLocalCommand(args, context);
    const argv = validateArgv(command.argv);
    const cwd = await this.resolveExistingPath(command.cwd, context);
    if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "registered command cwd is not a directory");
    const timeoutSeconds = registeredCommandTimeoutSeconds(args, command, context);
    const result = await this.runPublic(argv[0], argv.slice(1), timeoutSeconds * 1000, context, cwd);
    return publicProcessToolResult({ name: command.name, cwd: this.displayPath(cwd, context), timeout_seconds: timeoutSeconds, ...result });
  }
  async probeShell(context = {}, timeoutMs = 5_000) {
    const shell = workspaceShellCommand(process.platform === "win32" ? "cd" : "pwd");
    return this.run(shell.cmd, shell.args, timeoutMs, true, 64 * 1024, context);
  }
  async runFixedInternal(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES, context = {}, cwd = this.workspace) {
    const argv = validateArgv([cmd, ...args]);
    return this.run(argv[0], argv.slice(1), timeoutMs, allowFailure, maxOutputBytes, context, cwd, null, { internalFixed: true });
  }
  async runShell(command, timeoutSeconds, context = {}) {
    this.policyGate.assert("exec_command");
    if (!command || typeof command !== "string") throw new BridgeError("invalid_request", "command is required");
    if (command.includes("\0")) throw new BridgeError("invalid_request", "command contains a NUL byte");
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new BridgeError("limit_exceeded", `command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
    const shell = workspaceShellCommand(command);
    const result = await this.runPublic(
      shell.cmd, shell.args,
      processForegroundTimeoutSeconds("exec_command", timeoutSeconds, context) * 1000,
      context, this.workspace,
    );
    return publicProcessToolResult(result);
  }
  terminateAll(signal = "SIGTERM", escalate = false) {
    this.processTracker.terminateAll(signal, escalate);
  }
  async runPublic(cmd, args, timeoutMs, context, cwd) {
    const startedAt = Date.now();
    const result = await this.run(
      cmd, args, timeoutMs, true, PUBLIC_PROCESS_INLINE_OUTPUT_BYTES,
      context, cwd, null, { retainOutput: true },
    );
    const capture = result[PROCESS_OUTPUT_CAPTURE];
    const needsContinuation = result.stdout_truncated_bytes > 0 || result.stderr_truncated_bytes > 0;
    let continuation = {};
    if (needsContinuation && capture && this.retainCompletedOutput) {
      const session = this.retainCompletedOutput({
        command: basename(cmd), cwd,
        stdout: capture.stdout, stderr: capture.stderr,
        exitCode: result.code, startedAt, closedAt: Date.now(),
      }, context);
      if (session) {
        continuation = {
          output_session_id: session.session_id,
          output_continuation: {
            tool: "read_process",
            session_id: session.session_id,
            stdout_offset: 0,
            stderr_offset: 0,
            max_bytes: CONTINUATION_READ_BYTES,
            retained_bytes_per_stream: MAX_PROCESS_SESSION_OUTPUT_BYTES,
            expires_after_ms: PROCESS_SESSION_RETENTION_MS,
            retention: "best-effort-until-session-expiry-or-capacity-eviction",
          },
        };
      } else {
        continuation = { output_continuation_unavailable: "process session capacity reached" };
      }
    }
    const publicResult = { ...result, ...continuation };
    if (result.code !== 0) {
      throw new BridgeError("execution_failed", processFailureMessage(publicResult), {
        details: { process: publicResult },
      });
    }
    return publicResult;
  }
  async run(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES, context = {}, cwd = this.workspace, stdin = null, options = {}) {
    this.throwIfCancelled(context);
    if (stdin !== null && Buffer.byteLength(String(stdin)) > MAX_PROCESS_STDIN_BYTES) {
      throw new BridgeError("limit_exceeded", "process stdin exceeds 1 MiB");
    }
    const internalFixed = options.internalFixed === true;
    const baseEnvironment = executionEnv(this.workspace, {
      fullEnv: internalFixed ? false : this.policyForContext(context).minimalEnv === false,
      runtimeDir: this.runtimeDir,
    });
    const admitted = internalFixed || !this.resourceCoordinator
      ? { lease: null, environment: baseEnvironment, command: cmd, args }
      : await acquireProcessResources(this.resourceCoordinator, cmd, args, baseEnvironment, {
          cwd, priority: options.resourcePriority || "interactive", waitMs: options.resourceWaitMs ?? this.resourceWaitMs, signal: context.signal,
        });
    return new Promise((resolvePromise, rejectPromise) => {
      const stdout = new BoundedOutput(maxOutputBytes);
      const stderr = new BoundedOutput(maxOutputBytes);
      const retainedStdout = options.retainOutput ? new ProcessOutputStream(MAX_PROCESS_SESSION_OUTPUT_BYTES) : null;
      const retainedStderr = options.retainOutput ? new ProcessOutputStream(MAX_PROCESS_SESSION_OUTPUT_BYTES) : null;
      let child;
      try {
        const launch = internalFixed
          ? { command: cmd, args }
          : delegatedProcessCommand({ command: admitted.command, args: admitted.args, workspace: this.workspace, runtimeDir: this.runtimeDir, context });
        child = this.spawnProcess(launch.command, launch.args, {
          cwd,
          env: admitted.environment,
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        void releaseProcessResourcesQuietly(admitted.lease).then(() => rejectPromise(error));
        return;
      }

      this.processTracker.track(child, context.callId);
      let resourceBindError = null; let childError = null;
      const resourceBinding = bindProcessResources(admitted.lease, child).catch((error) => { resourceBindError = error; this.terminateProcess(child); });
      if (stdin !== null) {
        child.stdin?.on?.("error", () => {});
        child.stdin?.end?.(String(stdin));
      }

      let settled = false;
      let processClosed = false;
      let terminationTimer = null;
      let timeoutTimer = null;
      const signal = context.signal;

      const cleanupAfterClose = async () => {
        if (processClosed) return;
        processClosed = true;
        clearTimeout(timeoutTimer);
        signal?.removeEventListener?.("abort", onAbort);
        this.processTracker.untrack(child);
        await resourceBinding;
        await releaseProcessResources(admitted.lease);
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
        const reason = signal?.reason; const code = reason instanceof BridgeError && reason.code === "timeout" ? "timeout" : "cancelled";
        settle(() => rejectPromise(new BridgeError(code, reason instanceof Error ? reason.message : "tool call cancelled", {
          retryable: false, cause: reason instanceof Error ? reason : undefined, details: { side_effects_started: true, termination_requested: true, effect_settlement: "pending" },
        })));
      };
      const onAbort = () => rejectCancelled();
      signal?.addEventListener?.("abort", onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        terminate();
        settle(() => rejectPromise(new BridgeError("timeout", `command timed out after ${timeoutMs}ms`, {
          retryable: false,
          details: {
            side_effects_started: true,
            termination_requested: true,
            effect_settlement: "pending",
          },
        })));
      }, timeoutMs);
      timeoutTimer.unref?.();

      child.stdout?.on?.("data", (chunk) => {
        stdout.append(chunk);
        retainedStdout?.append(chunk);
      });
      child.stderr?.on?.("data", (chunk) => {
        stderr.append(chunk);
        retainedStderr?.append(chunk);
      });

      child.on("error", (error) => { childError ||= error; });
      attachChildProcessSettlement(child, {
        ...this.childSettlementOptions,
        onSettle: (code) => {
          void cleanupAfterClose().then(() => {
          if (settled) return;
          if (resourceBindError) { settle(() => rejectPromise(resourceBindError)); return; }
          if (childError) {
            const failure = processResult(127, stdout, childError.message || stderr.text(), retainedStdout, retainedStderr);
            settle(() => allowFailure ? resolvePromise(failure) : rejectPromise(childError)); return;
          }
          try { this.throwIfCancelled(context); } catch (error) {
            settle(() => rejectPromise(error));
            return;
          }
          const result = processResult(code, stdout, stderr, retainedStdout, retainedStderr);
          if (code === 0 || allowFailure) settle(() => resolvePromise(result));
          else settle(() => rejectPromise(new BridgeError("execution_failed", processFailureMessage(result), { details: { process: result } })));
          }, rejectPromise);
        },
      });

      if (signal?.aborted) rejectCancelled();
    });
  }
}

function processResult(code, stdout, stderr, retainedStdout = null, retainedStderr = null) {
  const stderrBuffer = stderr instanceof BoundedOutput ? stderr : null;
  const result = {
    code,
    stdout: stdout instanceof BoundedOutput ? stdout.text() : String(stdout || ""),
    stderr: stderrBuffer ? stderrBuffer.text() : boundedErrorMessage(stderr),
    stdout_truncated_bytes: stdout instanceof BoundedOutput ? stdout.truncatedBytes : 0,
    stderr_truncated_bytes: stderrBuffer ? stderrBuffer.truncatedBytes : 0,
  };
  if (retainedStdout && retainedStderr) {
    Object.defineProperty(result, PROCESS_OUTPUT_CAPTURE, {
      value: { stdout: retainedStdout, stderr: retainedStderr },
      enumerable: false,
    });
  }
  return result;
}
export function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "tool call failed";
}
