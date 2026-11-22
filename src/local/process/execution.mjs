import { BridgeError } from "../core/errors.mjs";
import { effectiveForegroundTimeoutSeconds, remoteForegroundDefaultSeconds, remoteDurableProcessTimeoutSeconds } from "../../shared/foreground-timeout.mjs";
import { MAX_PROCESS_TIMEOUT_SECONDS, DEFAULT_PROCESS_OUTPUT_BYTES, MAX_PROCESS_SESSION_OUTPUT_BYTES, MAX_PROCESS_STDIN_BYTES, PROCESS_SESSION_RETENTION_MS, PUBLIC_PROCESS_INLINE_OUTPUT_BYTES } from "./execution-limits.mjs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { BoundedOutput } from "../files/workspace-transaction.mjs";
import { attachChildProcessSettlement, ProcessOutputStream, processFailureMessage, publicProcessToolResult, processCancellationFailure, processChildErrorFailure, processPostSpawnFailure, processPreSpawnFailure, processTimeoutFailure, validateFixedProcessEnvironment } from "./settlement.mjs";
import { executionEnv, workspaceShellCommand } from "../deploy/shell.mjs";
import { terminateProcessTreeWithEscalation } from "./tree-facade.mjs";
import { acquireProcessResources, bindProcessResources, releaseProcessResources } from "./resource-process-admission.mjs";
import { classifyOperationalError } from "../core/log.mjs";
import { foregroundResourceWaitMs } from "./resource-admission-policy.mjs";
import { EXECUTION_SURFACE, withExecutionSurface } from "../core/authority.mjs";

export const MAX_COMMAND_BYTES = 64 * 1024;

export const MAX_ARGV_ITEMS = 256;

export function validateArgv(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ARGV_ITEMS) {
    throw new Error(`argv must contain 1-${MAX_ARGV_ITEMS} strings`);
  }
  const argv = value.map((item) => {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new Error("argv entries must be strings without NUL bytes");
    }
    return item;
  });
  if (!argv[0]) throw new Error("argv[0] must not be empty");
  if (Buffer.byteLength(JSON.stringify(argv)) > MAX_COMMAND_BYTES) {
    throw new Error(`argv exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  }
  return argv;
}

export function validateShellCommand(command) {
  if (!command || typeof command !== "string") throw new BridgeError("invalid_request", "command is required");
  if (command.includes("\0")) throw new BridgeError("invalid_request", "command contains a NUL byte");
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new BridgeError("limit_exceeded", `command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  return command;
}
// Relay-origin process one-shots should be routed through durable delivery before reaching this module.
// Keep a narrower defense-in-depth ceiling for any accidental direct foreground entry without advertising
// that value as a supported remote process delivery contract.
const REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS = 30;

export function processForegroundTimeoutSeconds(tool, value, context = {}) {
  const remote = context.origin === "relay";
  const timeout = effectiveForegroundTimeoutSeconds({
    tool,
    value,
    remote,
    localDefault: 120,
    localMaximum: MAX_PROCESS_TIMEOUT_SECONDS,
  });
  if (remote && timeout > REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS) {
    throw new RangeError(`foreground timeout must be an integer from 1 to ${REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS}`);
  }
  return timeout;
}

export function registeredCommandTimeoutSeconds(args, command, context = {}) {
  const remote = context.origin === "relay";
  const requested = args.timeout_seconds === undefined
    ? (remote ? remoteForegroundDefaultSeconds("run_local_command") : command.timeoutSeconds)
    : processForegroundTimeoutSeconds("run_local_command", args.timeout_seconds, context);
  return Math.min(
    requested,
    command.timeoutSeconds,
    remote ? REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS : MAX_PROCESS_TIMEOUT_SECONDS,
  );
}

export function durableProcessExecutionTimeoutSeconds(value) {
  return remoteDurableProcessTimeoutSeconds(value);
}

export function durableRegisteredCommandTimeoutSeconds(args, command) {
  return Math.min(
    remoteDurableProcessTimeoutSeconds(args.timeout_seconds),
    command.timeoutSeconds,
    MAX_PROCESS_TIMEOUT_SECONDS,
  );
}
export function boundedProcessErrorMessage(error, fallback = "process failed") {
  let message = "";
  try { message = error instanceof Error ? error.message : String(error); }
  catch { return fallback; }
  return message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 4096) || fallback;
}

const PROCESS_OUTPUT_CAPTURE = Symbol("process-output-capture");

const CONTINUATION_READ_BYTES = 64 * 1024;

function spawnDirectProcess(command, args, options) {
  // Keep the production child_process API separate from the injectable test seam and enforce non-shell execution.
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    windowsHide: options.windowsHide,
    shell: false,
  });
}

export class ProcessExecutionService {
  constructor({ workspace, policy, policyGate, policyForContext = null, runtimeDir, processTracker, resourceCoordinator = null, resourceWaitMs = undefined, resolveExistingPath, resolveLocalCommand, displayPath, throwIfCancelled, retainCompletedOutput = null, logger = null, spawnProcess = spawnDirectProcess, terminateProcess = terminateProcessTreeWithEscalation, childSettlementOptions = {} }) {
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
    this.logger = logger;
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
    return this.run(shell.cmd, shell.args, timeoutMs, true, 64 * 1024, context, this.workspace, null, { internalFixed: true });
  }
  async runFixedInternal(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES, context = {}, cwd = this.workspace, stdin = null, environment = {}) {
    const argv = validateArgv([cmd, ...args]);
    return this.run(argv[0], argv.slice(1), timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin, { internalFixed: true, internalEnvironment: validateFixedProcessEnvironment(environment) });
  }
  async runShell(command, timeoutSeconds, context = {}) {
    this.policyGate.assert("exec_command");
    const shell = workspaceShellCommand(validateShellCommand(command));
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
    const runtimeDir = this.runtimeDir;
    const baseEnvironment = executionEnv(this.workspace, {
      fullEnv: internalFixed ? false : this.policyForContext(context).minimalEnv === false, runtimeDir,
    });
    if (internalFixed) Object.assign(baseEnvironment, options.internalEnvironment || {});
    const executionEnvironment = internalFixed ? baseEnvironment : withExecutionSurface(baseEnvironment, EXECUTION_SURFACE.foregroundProcess);
    const admitted = internalFixed || !this.resourceCoordinator
      ? { lease: null, environment: executionEnvironment, command: cmd, args }
      : await acquireProcessResources(this.resourceCoordinator, cmd, args, executionEnvironment, {
          cwd, priority: options.resourcePriority || "interactive", waitMs: options.resourceWaitMs ?? foregroundResourceWaitMs(timeoutMs, this.resourceWaitMs), signal: context.signal,
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
          : { command: admitted.command, args: admitted.args };
        this.throwIfCancelled(context);
        child = this.spawnProcess(launch.command, launch.args, {
          cwd,
          env: admitted.environment,
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        void releaseProcessResources(admitted.lease)
          .catch((releaseError) => {
            this.logger?.warn?.("failed to release process resources after pre-spawn error", {
              error_class: classifyOperationalError(releaseError),
            });
          })
          .then(() => rejectPromise(
            processPreSpawnFailure(error, options.nonReplayableMutation === true),
          ));
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
      const nonReplayableMutation = options.nonReplayableMutation === true;
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
      const onAbort = () => {
        terminate();
        settle(() => rejectPromise(processCancellationFailure(nonReplayableMutation, signal)));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        terminate();
        settle(() => rejectPromise(processTimeoutFailure(nonReplayableMutation, timeoutMs)));
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
          if (resourceBindError) {
            settle(() => rejectPromise(processPostSpawnFailure(nonReplayableMutation, "resource_binding", resourceBindError)));
            return;
          }
          if (childError) {
            const failure = processResult(127, stdout, childError.message || stderr.text(), retainedStdout, retainedStderr);
            settle(() => {
              if (nonReplayableMutation) rejectPromise(processChildErrorFailure(true, childError, Boolean(child?.pid)));
              else if (allowFailure) resolvePromise(failure);
              else rejectPromise(childError);
            });
            return;
          }
          try { this.throwIfCancelled(context); } catch (error) {
            const trigger = signal?.reason instanceof BridgeError && signal.reason.code === "timeout" ? "timeout" : "cancelled";
            settle(() => rejectPromise(processPostSpawnFailure(nonReplayableMutation, trigger, error)));
            return;
          }
          const result = processResult(code, stdout, stderr, retainedStdout, retainedStderr);
          if (code === 0 || allowFailure) settle(() => resolvePromise(result));
          else settle(() => rejectPromise(processPostSpawnFailure(nonReplayableMutation, "nonzero_exit",
            new BridgeError("execution_failed", processFailureMessage(result), { details: { process: result } }), { process: result })));
          }, (error) => {
            const failure = !child?.pid && childError
              ? processPreSpawnFailure(new AggregateError([childError, error], "process spawn failed and resource cleanup was incomplete"), nonReplayableMutation)
              : processPostSpawnFailure(nonReplayableMutation, "resource_cleanup", error);
            if (!settle(() => rejectPromise(failure))) {
              this.logger?.warn?.("failed to release process resources after settlement", {
                error_class: classifyOperationalError(error),
              });
            }
          });
        },
      });

      if (signal?.aborted) onAbort();
    });
  }
}

function processResult(code, stdout, stderr, retainedStdout = null, retainedStderr = null) {
  const stderrBuffer = stderr instanceof BoundedOutput ? stderr : null;
  const result = {
    code,
    stdout: stdout instanceof BoundedOutput ? stdout.text() : String(stdout || ""),
    stderr: stderrBuffer ? stderrBuffer.text() : boundedProcessErrorMessage(stderr, "tool call failed"),
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
