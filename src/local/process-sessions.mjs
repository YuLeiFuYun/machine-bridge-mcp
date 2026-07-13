import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { executionEnv } from "./shell.mjs";
import { createToolAuthorizer } from "./policy.mjs";
import { clampInteger } from "./numbers.mjs";

export const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ARGV_ITEMS = 256;
const MAX_PROCESS_SESSIONS = 8;
const MAX_SESSION_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESS_STDIN_BYTES = 64 * 1024;
const PROCESS_SESSION_RETENTION_MS = 30 * 60 * 1000;

export class ProcessSessionManager {
  constructor({ workspace, policy, authorizeTool = null, runtimeDir, processTracker, resolveCwd, displayPath, throwIfCancelled }) {
    this.workspace = workspace;
    this.policy = policy;
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.runtimeDir = runtimeDir;
    this.processTracker = processTracker;
    this.resolveCwd = resolveCwd;
    this.displayPath = displayPath;
    this.throwIfCancelled = throwIfCancelled;
    this.sessions = new Map();
  }

  status() {
    return {
      active: [...this.sessions.values()].filter((session) => session.closedAt === null).length,
      retained: this.sessions.size,
      maximum: MAX_PROCESS_SESSIONS,
    };
  }

  clear() {
    this.sessions.clear();
  }

  notifyCancellation() {
    for (const session of this.sessions.values()) notifySessionWaiters(session);
  }

  async start(args, context = {}) {
    this.authorizeTool("start_process");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveCwd(args.cwd || ".");
    this.prune();
    if (this.sessions.size >= MAX_PROCESS_SESSIONS) throw new Error(`process session limit reached (${MAX_PROCESS_SESSIONS})`);
    this.throwIfCancelled(context);

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false, runtimeDir: this.runtimeDir }),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const session = {
      id: `proc_${randomBytes(24).toString("base64url")}`,
      child,
      argv0: basename(argv[0]),
      cwd,
      stdout: createSessionStream(),
      stderr: createSessionStream(),
      startedAt: Date.now(),
      lastActivity: Date.now(),
      closedAt: null,
      exitCode: null,
      signal: null,
      stdinClosed: false,
      waiters: new Set(),
    };
    this.sessions.set(session.id, session);
    this.trackChild(child, context.callId);

    child.stdout.on("data", (chunk) => {
      appendSessionStream(session.stdout, chunk);
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    child.stderr.on("data", (chunk) => {
      appendSessionStream(session.stderr, chunk);
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    child.on("close", (code, signal) => {
      session.exitCode = Number.isInteger(code) ? code : null;
      session.signal = signal ? String(signal) : null;
      session.closedAt = Date.now();
      session.lastActivity = Date.now();
      session.stdinClosed = true;
      this.untrackChild(child);
      notifySessionWaiters(session);
    });

    try {
      await waitForSpawn(child);
    } catch (error) {
      this.sessions.delete(session.id);
      this.untrackChild(child);
      throw error;
    }

    child.on("error", (error) => {
      appendSessionStream(session.stderr, Buffer.from(`${boundedErrorMessage(error)}\n`));
      session.lastActivity = Date.now();
      notifySessionWaiters(session);
    });
    this.throwIfCancelled(context);
    return this.summary(session);
  }

  async read(args, context = {}) {
    this.authorizeTool("read_process");
    const session = this.get(args.session_id);
    const stdoutOffset = clampInteger(args.stdout_offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const stderrOffset = clampInteger(args.stderr_offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = clampInteger(args.max_bytes, 64 * 1024, 1, 256 * 1024);
    const waitMs = clampInteger(args.wait_ms, 0, 0, 30_000);
    this.throwIfCancelled(context);
    const waitForExit = args.wait_for_exit === true;
    if (waitMs > 0 && session.closedAt === null) {
      const deadline = Date.now() + waitMs;
      if (waitForExit) {
        while (session.closedAt === null && Date.now() < deadline) {
          await waitForSessionChange(session, Math.max(1, deadline - Date.now()), () => this.throwIfCancelled(context));
        }
      } else if (!sessionHasOutputAfter(session, stdoutOffset, stderrOffset)) {
        await waitForSessionChange(session, waitMs, () => this.throwIfCancelled(context));
      }
    }
    this.throwIfCancelled(context);
    session.lastActivity = Date.now();
    return {
      ...this.summary(session),
      stdout: readSessionStream(session.stdout, stdoutOffset, maxBytes),
      stderr: readSessionStream(session.stderr, stderrOffset, maxBytes),
    };
  }

  async write(args, context = {}) {
    this.authorizeTool("write_process");
    const session = this.get(args.session_id);
    if (session.closedAt !== null) throw new Error("process session has already exited");
    const data = String(args.data ?? "");
    if (Buffer.byteLength(data) > MAX_PROCESS_STDIN_BYTES) throw new Error(`stdin data exceeds maximum size (${MAX_PROCESS_STDIN_BYTES} bytes)`);
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
    return { ...this.summary(session), bytes_written: Buffer.byteLength(data) };
  }

  async kill(args, context = {}) {
    this.authorizeTool("kill_process");
    const session = this.get(args.session_id);
    this.throwIfCancelled(context);
    const wasRunning = session.closedAt === null;
    if (wasRunning) terminateProcessTree(session.child, args.force === true ? "SIGKILL" : "SIGTERM");
    session.lastActivity = Date.now();
    return { ...this.summary(session), termination_requested: wasRunning, force: args.force === true };
  }

  get(sessionId) {
    this.prune();
    const id = String(sessionId || "");
    if (!/^proc_[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error("invalid process session id");
    const session = this.sessions.get(id);
    if (!session) throw new Error("process session not found or expired");
    return session;
  }

  summary(session) {
    return {
      session_id: session.id,
      command: session.argv0,
      cwd: this.displayPath(session.cwd),
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

export function validateArgv(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ARGV_ITEMS) throw new Error(`argv must contain 1-${MAX_ARGV_ITEMS} strings`);
  const argv = value.map((item) => {
    if (typeof item !== "string" || item.includes("\0")) throw new Error("argv entries must be strings without NUL bytes");
    return item;
  });
  if (!argv[0]) throw new Error("argv[0] must not be empty");
  if (Buffer.byteLength(JSON.stringify(argv)) > MAX_COMMAND_BYTES) throw new Error(`argv exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  return argv;
}

export function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    } catch {}
  }
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch {}
  }
}

export function terminateProcessTreeWithEscalation(child, options = {}) {
  const graceMs = Number.isFinite(Number(options.graceMs)) ? Math.max(0, Number(options.graceMs)) : 2000;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  terminateProcessTree(child, "SIGTERM");
  return schedule(() => terminateProcessTree(child, "SIGKILL"), graceMs);
}

function waitForSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => { cleanup(); resolvePromise(); };
    const onError = (error) => { cleanup(); rejectPromise(error); };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function createSessionStream() {
  return { buffer: Buffer.alloc(0), baseOffset: 0, totalBytes: 0 };
}

function appendSessionStream(stream, chunk) {
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
  stream.totalBytes += input.length;
  let combined = stream.buffer.length ? Buffer.concat([stream.buffer, input]) : Buffer.from(input);
  if (combined.length > MAX_SESSION_OUTPUT_BYTES) {
    const dropped = combined.length - MAX_SESSION_OUTPUT_BYTES;
    combined = combined.subarray(dropped);
    stream.baseOffset += dropped;
  }
  stream.buffer = combined;
}

function readSessionStream(stream, requestedOffset, maxBytes) {
  const clampedOffset = Math.min(requestedOffset, stream.totalBytes);
  const effectiveOffset = Math.max(clampedOffset, stream.baseOffset);
  const start = effectiveOffset - stream.baseOffset;
  const slice = stream.buffer.subarray(start, Math.min(stream.buffer.length, start + maxBytes));
  let data;
  let dataBase64;
  let encoding = "utf8";
  try {
    data = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    data = new TextDecoder("utf-8").decode(slice);
    dataBase64 = slice.toString("base64");
    encoding = "base64";
  }
  return {
    data,
    ...(dataBase64 ? { data_base64: dataBase64 } : {}),
    encoding,
    requested_offset: requestedOffset,
    start_offset: effectiveOffset,
    next_offset: effectiveOffset + slice.length,
    total_offset: stream.totalBytes,
    truncated_before: requestedOffset < stream.baseOffset,
    truncated_after: effectiveOffset + slice.length < stream.totalBytes,
  };
}

function sessionHasOutputAfter(session, stdoutOffset, stderrOffset) {
  return session.stdout.totalBytes > stdoutOffset || session.stderr.totalBytes > stderrOffset;
}

function notifySessionWaiters(session) {
  for (const waiter of [...session.waiters]) waiter();
}

function waitForSessionChange(session, waitMs, cancellationCheck) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const done = () => {
      cleanup();
      try {
        cancellationCheck();
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      session.waiters.delete(done);
    };
    session.waiters.add(done);
    timer = setTimeout(done, waitMs);
    timer.unref?.();
  });
}

function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "process failed";
}
