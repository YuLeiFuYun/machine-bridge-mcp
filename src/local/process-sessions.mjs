import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { executionEnv } from "./shell.mjs";
import { attachChildProcessSettlement } from "./child-process-settlement.mjs";
import { assertOwnedByContext, principalBinding, visibleToContext } from "./authority-context.mjs";
import { recordMatchesAuthorityRevocation } from "../shared/authority-revocation.mjs";
import { delegatedProcessCommand } from "./delegated-process-sandbox.mjs";
import { validateArgv } from "./process-contract.mjs";
import { terminateProcessTree, terminateProcessTreeWithEscalation } from "./process-tree.mjs";
import { createToolAuthorizer } from "./policy.mjs";
import { BridgeError, errorCode } from "./errors.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { clampInteger } from "./numbers.mjs";
import { ProcessOutputStream } from "./process-output-stream.mjs";
import { boundedErrorMessage, notifySessionWaiters, sessionHasOutputAfter, waitForSessionChange, waitForSpawn } from "./process-session-events.mjs";
import { terminateProcessSessions } from "./process-session-termination.mjs";
import { acquireProcessResources, bindProcessResources, releaseProcessResources, releaseProcessResourcesQuietly } from "./resource-process-admission.mjs";
import { processSessionResourceWaitMs } from "./resource-foreground-wait.mjs";
import {
  MAX_PROCESS_SESSIONS, MAX_PROCESS_SESSION_OUTPUT_BYTES, MAX_PROCESS_SESSION_STDIN_BYTES, PROCESS_SESSION_RETENTION_MS,
} from "./execution-limits.mjs";

const PROCESS_SESSION_TERMINATION_SETTLEMENT_MS = 5_000;

export class ProcessSessionManager {
  constructor({ workspace, policy, authorizeTool = null, policyForContext = null, runtimeDir, processTracker, resourceCoordinator = null, resourceWaitMs = undefined, terminationSettlementWaitMs = PROCESS_SESSION_TERMINATION_SETTLEMENT_MS, resolveCwd, displayPath, throwIfCancelled, terminateTree = terminateProcessTree, spawnProcess = spawn, childSettlementOptions = {} }) {
    this.workspace = workspace;
    this.policy = policy;
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.policyForContext = typeof policyForContext === "function" ? policyForContext : () => this.policy;
    this.runtimeDir = runtimeDir;
    this.processTracker = processTracker;
    this.resourceCoordinator = resourceCoordinator;
    this.resourceWaitMs = resourceWaitMs;
    this.terminationSettlementWaitMs = clampInteger(terminationSettlementWaitMs, PROCESS_SESSION_TERMINATION_SETTLEMENT_MS, 1, 30_000);
    this.resolveCwd = resolveCwd;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
    this.terminateTree = typeof terminateTree === "function" ? terminateTree : terminateProcessTree;
    this.spawnProcess = spawnProcess;
    this.childSettlementOptions = childSettlementOptions;
    this.sessions = new Map();
  }

  status(context = {}) {
    const visible = [...this.sessions.values()].filter((session) => visibleToContext(session, context));
    return {
      active: visible.filter((session) => session.closedAt === null).length,
      retained: visible.length,
      maximum: MAX_PROCESS_SESSIONS,
    };
  }

  async clearAndWait(signal = "SIGKILL") {
    return terminateProcessSessions({
      sessions: this.sessions, terminateTree: this.terminateTree, signal,
      waitMs: this.terminationSettlementWaitMs, mode: "shutdown",
    });
  }

  async revokeAuthority(revocation) {
    return terminateProcessSessions({
      sessions: this.sessions, terminateTree: this.terminateTree, signal: "SIGKILL",
      waitMs: this.terminationSettlementWaitMs, mode: "authority_revocation",
      matches: (session) => recordMatchesAuthorityRevocation(session, revocation),
    });
  }

  notifyCancellation() {
    for (const session of this.sessions.values()) notifySessionWaiters(session);
  }

  retainCompletedOutput({ command, cwd, stdout, stderr, exitCode, startedAt, closedAt = Date.now() }, context = {}) {
    this.prune();
    this.evictExitedForCapacity();
    if (this.sessions.size >= MAX_PROCESS_SESSIONS) return null;
    const completedAt = Number.isFinite(Number(closedAt)) ? Number(closedAt) : Date.now();
    const session = {
      id: `proc_${randomBytes(24).toString("base64url")}`,
      child: null,
      argv0: basename(String(command || "process")),
      cwd,
      stdout,
      stderr,
      startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : completedAt,
      lastActivity: completedAt,
      closedAt: completedAt,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: null,
      stdinClosed: true,
      waiters: new Set(),
      terminationTimer: null,
      ...principalBinding(context),
    };
    this.sessions.set(session.id, session);
    return this.summary(session, context);
  }

  async start(args, context = {}) {
    this.authorizeTool("start_process");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveCwd(args.cwd || ".", context);
    this.prune();
    this.evictExitedForCapacity();
    if (this.sessions.size >= MAX_PROCESS_SESSIONS) throw new Error(`process session limit reached (${MAX_PROCESS_SESSIONS})`);
    this.throwIfCancelled(context);

    const baseEnvironment = executionEnv(this.workspace, { fullEnv: this.policyForContext(context).minimalEnv === false, runtimeDir: this.runtimeDir });
    const admitted = await acquireProcessResources(this.resourceCoordinator, argv[0], argv.slice(1), baseEnvironment, {
      cwd, priority: "interactive", waitMs: processSessionResourceWaitMs(this.resourceWaitMs), signal: context.signal,
    });
    const launch = delegatedProcessCommand({ command: admitted.command, args: admitted.args, workspace: this.workspace, runtimeDir: this.runtimeDir, context });
    let child;
    try {
      child = this.spawnProcess(launch.command, launch.args, { cwd, env: admitted.environment, detached: process.platform !== "win32", windowsHide: true });
    } catch (error) {
      await releaseProcessResources(admitted.lease);
      throw error;
    }
    let resolveResourceBindingSettled;
    const resourceBindingSettled = new Promise((resolvePromise) => { resolveResourceBindingSettled = resolvePromise; });
    const session = {
      id: `proc_${randomBytes(24).toString("base64url")}`,
      child,
      argv0: basename(argv[0]),
      cwd,
      stdout: new ProcessOutputStream(MAX_PROCESS_SESSION_OUTPUT_BYTES),
      stderr: new ProcessOutputStream(MAX_PROCESS_SESSION_OUTPUT_BYTES),
      startedAt: Date.now(),
      lastActivity: Date.now(),
      closedAt: null,
      exitCode: null,
      signal: null,
      stdinClosed: false,
      waiters: new Set(),
      terminationTimer: null,
      startupFailed: false,
      resourceLease: admitted.lease,
      resourceBindingSettled,
      ...principalBinding(context),
    };
    this.sessions.set(session.id, session);
    this.trackChild(child, context.callId);

    child.stdout.on("data", (chunk) => {
      session.stdout.append(chunk);
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    child.stderr.on("data", (chunk) => {
      session.stderr.append(chunk);
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    attachChildProcessSettlement(child, {
      ...this.childSettlementOptions,
      onSettle: (code, signal) => {
        session.exitCode = Number.isInteger(code) ? code : null;
        session.signal = signal ? String(signal) : null;
        session.closedAt = Date.now();
        session.lastActivity = Date.now();
        session.stdinClosed = true;
        this.untrackChild(child);
        void session.resourceBindingSettled.then(() => releaseProcessResourcesQuietly(session.resourceLease));
        if (session.startupFailed) this.sessions.delete(session.id);
        notifySessionWaiters(session);
      },
    });

    child.on("error", (error) => {
      session.stderr.append(Buffer.from(`${boundedErrorMessage(error)}\n`));
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    try {
      await waitForSpawn(child);
      await bindProcessResources(admitted.lease, child);
      resolveResourceBindingSettled();
    } catch (error) {
      resolveResourceBindingSettled();
      throw this.failedStartError(session, error);
    }
    try { this.throwIfCancelled(context); }
    catch (error) { throw this.failedStartError(session, error); }
    return this.summary(session, context);
  }

  failedStartError(session, error) {
    session.startupFailed = true; session.stdinClosed = true;
    try { session.child?.stdin?.destroy?.(); }
    catch { /* Startup failure already owns the error path; closing stdin is best-effort cleanup. */ }
    if (session.closedAt !== null) {
      this.sessions.delete(session.id);
      return error;
    }
    let terminationRequested = false;
    try { terminationRequested = this.terminateTree(session.child, "SIGKILL") === true; }
    catch { /* The returned settlement metadata records that child termination could not be confirmed. */ }
    session.lastActivity = Date.now();
    const code = errorCode(error);
    return new BridgeError(code, "process session start failed after the child was spawned", {
      cause: error instanceof Error ? error : undefined,
      retryable: false,
      details: {
        side_effects_started: true,
        termination_requested: terminationRequested,
        effect_settlement: terminationRequested ? "pending" : "unknown",
        ownership_retained_until_close: true,
      },
    });
  }

  async read(args, context = {}) {
    this.authorizeTool("read_process");
    const session = this.get(args.session_id, context);
    const stdoutOffset = clampInteger(args.stdout_offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const stderrOffset = clampInteger(args.stderr_offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = clampInteger(args.max_bytes, 64 * 1024, 1, 256 * 1024);
    const waitMs = clampInteger(args.wait_ms, 0, 0, 30_000);
    this.throwIfCancelled(context);
    const waitForExit = args.wait_for_exit === true;
    if (waitMs > 0 && session.closedAt === null) {
      const deadline = createMonotonicDeadline(waitMs);
      if (waitForExit) {
        while (session.closedAt === null && !deadline.expired()) {
          await waitForSessionChange(session, Math.max(1, deadline.remainingMs()), () => this.throwIfCancelled(context));
        }
      } else if (!sessionHasOutputAfter(session, stdoutOffset, stderrOffset)) {
        await waitForSessionChange(session, waitMs, () => this.throwIfCancelled(context));
      }
    }
    this.throwIfCancelled(context);
    session.lastActivity = Date.now();
    return {
      ...this.summary(session, context),
      stdout: session.stdout.read(stdoutOffset, maxBytes),
      stderr: session.stderr.read(stderrOffset, maxBytes),
    };
  }

  async write(args, context = {}) {
    this.authorizeTool("write_process");
    const session = this.get(args.session_id, context);
    if (session.closedAt !== null) throw new Error("process session has already exited");
    const data = String(args.data ?? "");
    if (Buffer.byteLength(data) > MAX_PROCESS_SESSION_STDIN_BYTES) throw new Error(`stdin data exceeds maximum size (${MAX_PROCESS_SESSION_STDIN_BYTES} bytes)`);
    if (session.stdinClosed || session.child.stdin.destroyed) throw new Error("process session stdin is closed");
    this.throwIfCancelled(context);
    if (data) {
      await new Promise((resolvePromise, rejectPromise) => {
        session.child.stdin.write(data, (error) => error ? rejectPromise(error) : resolvePromise());
      });
    }
    if (args.close_stdin === true) {
      session.child.stdin.end();
      session.stdinClosed = true;
    }
    session.lastActivity = Date.now();
    return { ...this.summary(session, context), bytes_written: Buffer.byteLength(data) };
  }

  async kill(args, context = {}) {
    this.authorizeTool("kill_process");
    const session = this.get(args.session_id, context);
    this.throwIfCancelled(context);
    const wasRunning = session.closedAt === null;
    const force = args.force === true;
    if (wasRunning && force && !this.terminateTree(session.child, "SIGKILL")) {
      throw new BridgeError("unavailable", "process termination request could not be delivered", { retryable: true });
    } else if (wasRunning && !force && !session.terminationTimer) {
      session.terminationTimer = terminateProcessTreeWithEscalation(session.child, {
        terminate: this.terminateTree,
        onTerminationSettled: () => { session.terminationTimer = null; },
      });
    }
    session.lastActivity = Date.now();
    return {
      ...this.summary(session, context),
      termination_requested: wasRunning,
      force,
      force_after_ms: wasRunning && !force ? 2000 : null,
    };
  }

  get(sessionId, context = {}) {
    this.prune();
    const id = String(sessionId || "");
    if (!/^proc_[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error("invalid process session id");
    const session = this.sessions.get(id);
    if (!session) throw new Error("process session not found or expired");
    assertOwnedByContext(session, context, "process session");
    return session;
  }

  summary(session, context = {}) {
    return {
      session_id: session.id,
      command: session.argv0,
      cwd: this.displayPath(session.cwd, context),
      running: session.closedAt === null,
      exit_code: session.exitCode,
      signal: session.signal,
      stdin_closed: session.stdinClosed,
      started_at: new Date(session.startedAt).toISOString(),
      closed_at: session.closedAt ? new Date(session.closedAt).toISOString() : null,
      stdout_offset: session.stdout.totalBytes,
      stderr_offset: session.stderr.totalBytes,
    };
  }

  prune() {
    const cutoff = Date.now() - PROCESS_SESSION_RETENTION_MS;
    for (const [id, session] of this.sessions) {
      if (session.closedAt !== null && session.lastActivity < cutoff) this.sessions.delete(id);
    }
  }

  evictExitedForCapacity() {
    if (this.sessions.size < MAX_PROCESS_SESSIONS) return;
    const exited = [...this.sessions.values()]
      .filter((session) => session.closedAt !== null)
      .sort((left, right) => left.lastActivity - right.lastActivity);
    for (const session of exited) {
      if (this.sessions.size < MAX_PROCESS_SESSIONS) break;
      this.sessions.delete(session.id);
    }
  }


  trackChild(child, callId) {
    this.processTracker.track(child, callId);
  }

  untrackChild(child) {
    this.processTracker.untrack(child);
  }
}
