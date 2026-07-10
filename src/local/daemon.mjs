import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";

const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_PATH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;

const ALL_TOOL_NAMES = [
  "project_overview",
  "list_roots",
  "list_dir",
  "list_files",
  "read_file",
  "write_file",
  "search_text",
  "git_status",
  "git_diff",
  "exec_command",
];

export class LocalDaemon {
  constructor({ workerUrl, secret, workspace, policy, logger = console }) {
    this.workerUrl = normalizeWorkerUrl(workerUrl);
    if (typeof secret !== "string" || secret.length < 16) throw new Error("daemon secret is missing or too short");
    this.secret = secret;
    this.workspace = realpathSync(resolve(workspace || process.cwd()));
    this.policy = {
      allowWrite: policy?.allowWrite !== false,
      allowExec: policy?.allowExec !== false,
      unrestrictedPaths: policy?.unrestrictedPaths === true,
      minimalEnv: policy?.minimalEnv !== false,
    };
    this.logger = logger;
    this.closed = false;
    this.ws = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.connectedOnce = null;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.activeToolCalls = 0;
    this.activeProcesses = new Set();
    this.reconnectAttempt = 0;
  }

  tools() {
    return ALL_TOOL_NAMES.filter(name => {
      if (name === "write_file") return this.policy.allowWrite;
      if (name === "exec_command") return this.policy.allowExec;
      return true;
    });
  }

  start() {
    this.closed = false;
    this.connectedOnce = new Promise((resolvePromise, rejectPromise) => {
      this.connectedOnceResolve = resolvePromise;
      this.connectedOnceReject = rejectPromise;
    });
    this.connect();
    return this.connectedOnce;
  }

  stop() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.terminateActiveProcesses("SIGKILL");
    this.reconnectAttempt = 0;
  }

  connect() {
    if (this.closed) return;
    const wsUrl = `${this.workerUrl.replace(/^http/i, "ws")}/daemon/ws`;
    this.logger.info?.(`connecting daemon websocket: ${wsUrl}`);
    const socket = new WebSocket(wsUrl, {
      headers: {
        "X-Bridge-Token": this.secret,
      },
    });
    this.ws = socket;

    socket.on("open", () => {
      if (this.ws !== socket || this.closed) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.logger.info?.("daemon websocket connected");
      this.send({
        type: "hello",
        tools: this.tools(),
        policy: this.policy,
      });
      if (this.connectedOnceResolve) {
        this.connectedOnceResolve(true);
        this.connectedOnceResolve = null;
        this.connectedOnceReject = null;
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: "heartbeat", ts: Date.now() }), 25_000);
      this.heartbeat.unref?.();
    });

    socket.on("message", data => {
      const raw = String(data);
      if (Buffer.byteLength(raw) > MAX_WS_MESSAGE_BYTES) {
        this.logger.warn?.("oversized websocket message rejected");
        return;
      }
      void this.handleMessage(raw).catch(error => {
        this.logger.error?.(`daemon message handler failed: ${error.message}`);
      });
    });

    socket.on("close", (code, reason) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.terminateActiveProcesses("SIGTERM", true);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      const text = `daemon websocket closed: ${code} ${String(reason || "")}`;
      if (this.closed) this.logger.info?.(text);
      else this.logger.warn?.(text);
      if (!this.closed) {
        const delay = reconnectDelay(this.reconnectAttempt++);
        this.logger.debug?.("scheduling daemon reconnect", { delay_ms: delay });
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        this.reconnectTimer.unref?.();
      }
    });

    socket.on("error", error => {
      if (this.ws !== socket) return;
      // Do not reject the first-connection promise: the close handler schedules
      // reconnects, and first deploy propagation can briefly race WebSocket setup.
      if (this.closed) this.logger.info?.(`daemon websocket closed during shutdown: ${error.message}`);
      else this.logger.error?.(`daemon websocket error: ${error.message}`);
    });
  }

  send(value) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(value));
      return true;
    } catch (error) {
      this.logger.warn?.(`daemon websocket send failed: ${boundedErrorMessage(error)}`);
      return false;
    }
  }

  async handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.logger.warn?.("invalid websocket JSON");
      return;
    }
    if (message.type === "welcome" || message.type === "hello_ack" || message.type === "pong") return;
    if (message.type !== "tool_call") {
      this.logger.warn?.(`unknown websocket message: ${message.type}`);
      return;
    }

    const id = typeof message.id === "string" ? message.id : "";
    if (!id || typeof message.tool !== "string") {
      this.logger.warn?.("invalid tool_call envelope");
      return;
    }
    if (this.activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
      this.send({ type: "tool_result", id, ok: false, error: { message: "too many concurrent tool calls" } });
      return;
    }
    this.activeToolCalls += 1;
    try {
      const result = await this.executeTool(message.tool, message.arguments || {});
      this.send({ type: "tool_result", id, ok: true, result });
    } catch (error) {
      this.send({ type: "tool_result", id, ok: false, error: { message: boundedErrorMessage(error) } });
    } finally {
      this.activeToolCalls -= 1;
    }
  }

  async executeTool(tool, args) {
    switch (tool) {
      case "project_overview": return this.projectOverview();
      case "list_roots": return this.listRoots();
      case "list_dir": return this.listDir(args.path || ".");
      case "list_files": return this.listFiles(args.path || ".", clampInt(args.max_files, 1000, 1, 10000));
      case "read_file": return this.readFile(args.path, clampInt(args.max_bytes, 1024 * 1024, 1, 5 * 1024 * 1024));
      case "write_file": return this.writeFile(args);
      case "search_text": return this.searchText(args);
      case "git_status": return this.gitStatus(args);
      case "git_diff": return this.gitDiff(args);
      case "exec_command": return this.execCommand(args.command, clampInt(args.timeout_seconds, 120, 1, 600));
      default: throw new Error(`unknown daemon tool: ${tool}`);
    }
  }

  async projectOverview() {
    const top = await this.listDir(".").catch(error => ({ error: error.message, entries: [] }));
    const git = await this.runProcess("git", ["-C", this.workspace, "rev-parse", "--show-toplevel"], 10_000, true);
    return {
      workspace: this.workspace,
      workspaceName: basename(this.workspace),
      gitRoot: git.code === 0 ? git.stdout.trim() : "",
      policy: this.policy,
      tools: this.tools(),
      topLevel: top.entries || [],
    };
  }

  listRoots() {
    const roots = [{ name: basename(this.workspace), path: this.workspace, default: true }];
    if (this.policy.unrestrictedPaths) {
      const home = process.env.HOME;
      if (home && home !== this.workspace) roots.push({ name: "home", path: home, default: false });
      roots.push({ name: "filesystem-root", path: path.parse(this.workspace).root, default: false });
    }
    return { roots };
  }

  async listDir(inputPath) {
    const full = await this.resolveExistingPath(inputPath);
    const entries = [];
    let resultBytes = 0;
    let truncated = false;
    for await (const entry of await opendir(full)) {
      const entryPath = resolve(full, entry.name);
      const info = await lstat(entryPath).catch(() => null);
      const item = {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: info?.size ?? 0,
      };
      const itemBytes = Buffer.byteLength(item.name) + Buffer.byteLength(item.path) + 64;
      if (entries.length >= MAX_DIRECTORY_ENTRIES || resultBytes + itemBytes > MAX_PATH_RESULT_BYTES) {
        truncated = true;
        break;
      }
      entries.push(item);
      resultBytes += itemBytes;
    }
    entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return { path: full, entries, truncated };
  }

  async listFiles(inputPath, maxFiles) {
    const root = await this.resolveExistingPath(inputPath);
    const info = await stat(root);
    if (info.isFile()) return { path: root, files: [root], truncated: false };
    if (!info.isDirectory()) throw new Error("path is not a file or directory");
    const files = [];
    let resultBytes = 0;
    const walkResult = await this.walk(root, async full => {
      const pathBytes = Buffer.byteLength(full) + 8;
      if (files.length >= maxFiles || resultBytes + pathBytes > MAX_PATH_RESULT_BYTES) return false;
      files.push(full);
      resultBytes += pathBytes;
      return true;
    });
    return { path: root, files, truncated: files.length >= maxFiles || resultBytes >= MAX_PATH_RESULT_BYTES || walkResult.truncated };
  }

  async readFile(inputPath, maxBytes) {
    if (!inputPath) throw new Error("path is required");
    const full = await this.resolveExistingPath(inputPath);
    const info = await stat(full);
    if (!info.isFile()) throw new Error("path is not a file");
    if (info.size > maxBytes) throw new Error(`file exceeds max_bytes (${info.size} > ${maxBytes})`);
    const content = await readUtf8File(full);
    return { path: full, size: info.size, sha256: sha256(content), content };
  }

  async writeFile(args) {
    if (!this.policy.allowWrite) throw new Error("write_file is disabled by daemon policy");
    if (!args.path) throw new Error("path is required");
    const content = String(args.content ?? "");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_WRITE_BYTES) throw new Error(`content exceeds maximum write size (${bytes} > ${MAX_WRITE_BYTES})`);
    const full = await this.resolveWritePath(args.path);
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error("refusing to overwrite a symbolic link");
    if (args.create_only && existing) throw new Error("file exists and create_only=true");
    if (existing && !existing.isFile()) throw new Error("path is not a regular file");
    if (args.expected_sha256) {
      if (!existing) throw new Error("expected_sha256 requires an existing file");
      const current = await readUtf8File(full);
      if (sha256(current) !== String(args.expected_sha256)) throw new Error("expected_sha256 mismatch");
    }
    await mkdir(dirname(full), { recursive: true });
    if (args.create_only) {
      await writeFile(full, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else {
      const temp = join(dirname(full), `.${basename(full)}.mbm-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: existing ? existing.mode & 0o777 : 0o600 });
        if (existing) await chmod(temp, existing.mode & 0o777).catch(() => {});
        await rename(temp, full);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
    return { ok: true, path: full, sha256: sha256(content), bytes };
  }

  async searchText(args) {
    const query = String(args.query || "");
    if (!query) throw new Error("query is required");
    const root = await this.resolveExistingPath(args.path || ".");
    const max = clampInt(args.max_matches, 100, 1, 1000);
    const maxFiles = clampInt(args.max_files, 10000, 1, 100000);
    let visitedFiles = 0;
    const matches = [];
    const rootInfo = await stat(root);
    if (rootInfo.isFile()) {
      await this.searchOneFile(root, query, matches, max);
      return { query, root, matches, visited_files: 1, truncated: matches.length >= max };
    }
    if (!rootInfo.isDirectory()) throw new Error("path is not a file or directory");
    const walkResult = await this.walk(root, async full => {
      if (matches.length >= max || visitedFiles >= maxFiles) return false;
      visitedFiles += 1;
      await this.searchOneFile(full, query, matches, max);
      return matches.length < max && visitedFiles < maxFiles;
    });
    return { query, root, matches, visited_files: visitedFiles, truncated: matches.length >= max || visitedFiles >= maxFiles || walkResult.truncated };
  }

  async searchOneFile(full, query, matches, max) {
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > 1024 * 1024) return;
    const buffer = await readFile(full).catch(() => null);
    if (!buffer || buffer.includes(0)) return;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return; }
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({ path: full, line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= max) break;
      }
    }
  }

  async gitStatus(args = {}) {
    const context = await this.gitContext(args.path || ".");
    if (!context.ok) return context.result;
    const commandArgs = ["-c", "core.fsmonitor=false", "-C", context.root, "status", "--short"];
    if (context.pathspec) commandArgs.push("--", context.pathspec);
    return this.runProcess("git", commandArgs, 30_000, true);
  }

  async gitDiff(args = {}) {
    const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, 5 * 1024 * 1024);
    const context = await this.gitContext(args.path || ".");
    if (!context.ok) return { ...context.result, path: context.target };
    const commandArgs = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", context.root, "diff", "--no-ext-diff", "--no-textconv"];
    if (context.pathspec) commandArgs.push("--", context.pathspec);
    const result = await this.runProcess("git", commandArgs, 60_000, true, maxBytes);
    return { ...result, path: context.target, gitRoot: context.root };
  }

  async gitContext(inputPath) {
    const target = await this.resolveExistingPath(inputPath);
    const info = await stat(target);
    const cwd = info.isDirectory() ? target : dirname(target);
    const result = await this.runProcess("git", ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--show-toplevel"], 10_000, true);
    if (result.code !== 0) return { ok: false, result, target };
    const root = result.stdout.trim();
    const relative = path.relative(root, target);
    if (relative.startsWith(`..${sep}`) || relative === ".." || isAbsolute(relative)) {
      return { ok: false, target, result: { code: 128, stdout: "", stderr: "target is outside the detected git repository" } };
    }
    return { ok: true, target, root, pathspec: relative || "" };
  }

  async execCommand(command, timeoutSeconds) {
    if (!this.policy.allowExec) throw new Error("exec_command is disabled by daemon policy");
    if (!command || typeof command !== "string") throw new Error("command is required");
    if (command.includes("\0")) throw new Error("command contains a NUL byte");
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error(`command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
    const shell = workspaceShellCommand(command);
    return this.runProcess(shell.cmd, shell.args, clampInt(timeoutSeconds, 120, 1, 600) * 1000);
  }

  terminateActiveProcesses(signal = "SIGTERM", escalate = false) {
    const children = [...this.activeProcesses];
    for (const child of children) terminateProcessTree(child, signal);
    if (escalate && signal !== "SIGKILL" && children.length) {
      const timer = setTimeout(() => {
        for (const child of children) {
          if (this.activeProcesses.has(child)) terminateProcessTree(child, "SIGKILL");
        }
      }, 2000);
      timer.unref?.();
    }
  }

  async runProcess(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = 512 * 1024) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, {
        cwd: this.workspace,
        env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false }),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.activeProcesses.add(child);
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = 0;
      let stderrTruncated = 0;
      let timedOut = false;
      let settled = false;
      let killTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2000);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        this.activeProcesses.delete(child);
      };
      const finish = callback => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      child.stdout.on("data", chunk => {
        const next = appendLimited(stdout, chunk, maxOutputBytes);
        stdout = next.value;
        stdoutTruncated += next.truncated;
      });
      child.stderr.on("data", chunk => {
        const next = appendLimited(stderr, chunk, maxOutputBytes);
        stderr = next.value;
        stderrTruncated += next.truncated;
      });
      child.on("error", error => finish(() => {
        if (allowFailure) resolvePromise({ code: 127, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: boundedErrorMessage(error) });
        else reject(error);
      }));
      child.on("close", code => finish(() => {
        const result = { code, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: finalizeOutput(stderr, stderrTruncated) };
        if (timedOut) {
          reject(new Error(`command timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0 || allowFailure) resolvePromise(result);
        else reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
      }));
    });
  }

  async walk(root, onFile) {
    const stack = [root];
    let visitedEntries = 0;
    while (stack.length) {
      const current = stack.pop();
      const entries = await opendir(current).catch(() => null);
      if (!entries) continue;
      for await (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_WALK_ENTRIES) return { truncated: true, visitedEntries };
        const full = resolve(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          const keepGoing = await onFile(full);
          if (keepGoing === false) return { truncated: true, visitedEntries };
        }
      }
    }
    return { truncated: false, visitedEntries };
  }

  resolvePath(inputPath = ".") {
    const raw = String(inputPath || ".");
    if (raw.includes("\0")) throw new Error("path contains a NUL byte");
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(this.workspace, raw);
    return candidate;
  }

  async resolveExistingPath(inputPath = ".") {
    const candidate = this.resolvePath(inputPath);
    const canonical = await realpath(candidate);
    if (!this.policy.unrestrictedPaths) assertContainedPath(this.workspace, canonical);
    return canonical;
  }

  async resolveWritePath(inputPath = ".") {
    const candidate = this.resolvePath(inputPath);
    if (this.policy.unrestrictedPaths) return candidate;
    let ancestor = candidate;
    while (!(await lstat(ancestor).catch(() => null))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const canonicalAncestor = await realpath(ancestor);
    assertContainedPath(this.workspace, canonicalAncestor);
    return candidate;
  }
}

function normalizeWorkerUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("invalid Worker URL"); }
  if (url.protocol !== "https:") throw new Error("Worker URL must use HTTPS");
  if (url.username || url.password) throw new Error("Worker URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Worker URL must be an origin without a path, query, or fragment");
  return url.origin;
}

function reconnectDelay(attempt) {
  const base = Math.min(3000 * (2 ** Math.min(attempt, 4)), 60_000);
  return base + Math.floor(Math.random() * 1000);
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    } catch {}
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function assertContainedPath(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${sep}`) && relative !== ".." && !isAbsolute(relative))) return;
  throw new Error("path is outside the configured workspace; restart with --unrestricted-paths to allow it");
}

async function readUtf8File(filePath) {
  const buffer = await readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("file is not valid UTF-8 text");
  }
}

function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "tool call failed";
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function appendLimited(current, chunk, max) {
  const text = String(chunk || "");
  const budget = Math.max(0, max - Buffer.byteLength(current));
  const textBytes = Buffer.byteLength(text);
  if (textBytes <= budget) return { value: current + text, truncated: 0 };
  const slice = Buffer.from(text).subarray(0, budget).toString();
  return { value: current + slice, truncated: textBytes - Buffer.byteLength(slice) };
}

function finalizeOutput(value, truncated) {
  return truncated > 0 ? `${value}\n\n[truncated ${truncated} bytes]` : value;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, min), max);
}

export async function daemonSelfTest() {
  const workspace = await mkdtemp(join(tmpdir(), "mbm-daemon-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "mbm-daemon-outside-"));
  const logger = { info() {}, warn() {}, error() {} };
  const restricted = new LocalDaemon({
    workerUrl: "https://example.invalid",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true },
    logger,
  });
  const unrestricted = new LocalDaemon({
    workerUrl: "https://example.invalid",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true },
    logger,
  });
  const previousSecret = process.env.MBM_DAEMON_SELFTEST_SECRET;
  process.env.MBM_DAEMON_SELFTEST_SECRET = "should-not-leak";
  try {
    await writeFile(join(workspace, ".env"), "SECRET=visible", "utf8");
    await writeFile(join(workspace, "visible.txt"), "needle", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside-needle", "utf8");

    const envFile = await restricted.readFile(".env", 1024);
    if (!envFile.content.includes("SECRET=visible")) throw new Error("workspace .env should remain readable");

    await expectReject(() => restricted.readFile(join(outside, "outside.txt"), 1024), "outside the configured workspace");
    await expectReject(() => restricted.readFile(path.relative(workspace, join(outside, "outside.txt")), 1024), "outside the configured workspace");

    const outsideFile = await unrestricted.readFile(join(outside, "outside.txt"), 1024);
    if (!outsideFile.content.includes("outside-needle")) throw new Error("unrestricted absolute read failed");

    const linkPath = join(workspace, "outside-link");
    try {
      await symlink(outside, linkPath, "dir");
      await expectReject(() => restricted.readFile(join(linkPath, "outside.txt"), 1024), "outside the configured workspace");
      await expectReject(() => restricted.writeFile({ path: linkPath, content: "replace" }), "outside the configured workspace");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }

    const written = await restricted.writeFile({ path: "nested/written.txt", content: "written", create_only: true });
    if (written.bytes !== 7) throw new Error("write_file byte count is incorrect");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", create_only: true }), "file exists");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", expected_sha256: "bad" }), "expected_sha256 mismatch");
    await restricted.writeFile({ path: "nested/written.txt", content: "updated", expected_sha256: sha256("written") });
    if (await readFile(join(workspace, "nested/written.txt"), "utf8") !== "updated") throw new Error("atomic update failed");
    await expectReject(() => restricted.writeFile({ path: "too-large.txt", content: "x".repeat(MAX_WRITE_BYTES + 1) }), "maximum write size");

    await writeFile(join(workspace, "invalid.bin"), Buffer.from([0xff, 0xfe]));
    await expectReject(() => restricted.readFile("invalid.bin", 1024), "not valid UTF-8");
    const binarySearch = await restricted.searchText({ path: workspace, query: "needle", max_files: 100, max_matches: 10 });
    if (!binarySearch.matches.some(match => match.path.endsWith("visible.txt"))) throw new Error("search_text missed UTF-8 file");

    const cappedSearch = await restricted.searchText({ path: workspace, query: "definitely-not-present", max_files: 1, max_matches: 10 });
    if (cappedSearch.visited_files !== 1 || cappedSearch.truncated !== true) throw new Error("search_text max_files cap did not apply");

    const repo = join(workspace, "nested-repo");
    await mkdir(repo);
    await restricted.runProcess("git", ["init", "-q", repo], 10_000);
    await writeFile(join(repo, "tracked.txt"), "one\n", "utf8");
    await restricted.runProcess("git", ["-C", repo, "add", "tracked.txt"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "config", "diff.external", "definitely-not-a-real-diff-command"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "config", "core.fsmonitor", "definitely-not-a-real-fsmonitor-command"], 10_000);
    await writeFile(join(repo, "tracked.txt"), "two\n", "utf8");
    const diff = await restricted.gitDiff({ path: "nested-repo" });
    if (diff.code !== 0 || !diff.stdout.includes("tracked.txt") || diff.gitRoot !== await realpath(repo)) throw new Error("nested git diff detection failed");
    const status = await restricted.gitStatus({ path: "nested-repo" });
    if (status.code !== 0 || !status.stdout.includes("tracked.txt")) throw new Error("nested git status detection failed");

    const command = await restricted.execCommand("printf ${MBM_DAEMON_SELFTEST_SECRET-unset}", 5);
    if (command.stdout !== "unset") throw new Error("exec_command inherited unallowlisted environment variables");
    await expectReject(() => restricted.execCommand(`printf '${"x".repeat(MAX_COMMAND_BYTES)}'`, 5), "maximum size");
    await expectReject(() => restricted.execCommand("printf 'x\0y'", 5), "NUL byte");
    if (process.platform !== "win32") {
      await expectReject(() => restricted.execCommand("sleep 5", 1), "command timed out");
      const interrupted = restricted.runProcess("sleep", ["30"], 60_000);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      restricted.terminateActiveProcesses("SIGTERM");
      await expectReject(() => interrupted, "exited");
      if (restricted.activeProcesses.size !== 0) throw new Error("terminated process remained tracked");
    }

    const restrictedRoots = restricted.listRoots();
    if (restrictedRoots.roots.length !== 1 || restrictedRoots.roots[0].path !== await realpath(workspace)) throw new Error("restricted roots exposed paths outside workspace");
    const unrestrictedRoots = unrestricted.listRoots();
    if (!unrestrictedRoots.roots.some(root => root.path === path.parse(workspace).root)) throw new Error("unrestricted filesystem root missing");
  } finally {
    if (previousSecret === undefined) delete process.env.MBM_DAEMON_SELFTEST_SECRET;
    else process.env.MBM_DAEMON_SELFTEST_SECRET = previousSecret;
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

async function expectReject(callback, pattern) {
  try {
    await callback();
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}
