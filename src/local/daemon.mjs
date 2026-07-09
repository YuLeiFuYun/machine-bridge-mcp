import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";

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
    this.workerUrl = String(workerUrl || "").replace(/\/+$/, "");
    this.secret = secret;
    this.workspace = resolve(workspace || process.cwd());
    this.policy = {
      allowWrite: policy?.allowWrite !== false,
      allowExec: policy?.allowExec !== false,
      unrestrictedPaths: policy?.unrestrictedPaths !== false,
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
  }

  connect() {
    if (this.closed) return;
    const wsUrl = `${this.workerUrl.replace(/^http/i, "ws")}/daemon/ws`;
    this.logger.info?.(`connecting daemon websocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl, {
      headers: {
        "X-Bridge-Token": this.secret,
        "X-Daemon-Id": `local-${process.pid}`,
      },
    });

    this.ws.on("open", () => {
      this.logger.info?.("daemon websocket connected");
      this.send({
        type: "hello",
        workspace_hash: sha256(this.workspace),
        workspace_name: basename(this.workspace),
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

    this.ws.on("message", data => {
      void this.handleMessage(String(data)).catch(error => {
        this.logger.error?.(`daemon message handler failed: ${error.message}`);
      });
    });

    this.ws.on("close", (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      const text = `daemon websocket closed: ${code} ${String(reason || "")}`;
      if (this.closed) this.logger.info?.(text);
      else this.logger.warn?.(text);
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        this.reconnectTimer.unref?.();
      }
    });

    this.ws.on("error", error => {
      // Do not reject the first-connection promise: the close handler schedules
      // reconnects, and first deploy propagation can briefly race WebSocket setup.
      if (this.closed) this.logger.info?.(`daemon websocket closed during shutdown: ${error.message}`);
      else this.logger.error?.(`daemon websocket error: ${error.message}`);
    });
  }

  send(value) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
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

    const id = message.id;
    try {
      const result = await this.executeTool(message.tool, message.arguments || {});
      this.send({ type: "tool_result", id, ok: true, result });
    } catch (error) {
      this.send({ type: "tool_result", id, ok: false, error: { message: error.message } });
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
      case "git_status": return this.runProcess("git", ["-C", this.workspace, "status", "--short"], 30_000, true);
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
    const home = process.env.HOME;
    if (home && home !== this.workspace) roots.push({ name: "home", path: home, default: false });
    roots.push({ name: "filesystem-root", path: path.parse(this.workspace).root, default: false });
    return { roots };
  }

  async listDir(inputPath) {
    const full = this.resolvePath(inputPath);
    const entries = [];
    for await (const entry of await opendir(full)) {
      const entryPath = resolve(full, entry.name);
      const info = await stat(entryPath).catch(() => null);
      entries.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        size: info?.size ?? 0,
      });
    }
    entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return { path: full, entries };
  }

  async listFiles(inputPath, maxFiles) {
    const root = this.resolvePath(inputPath);
    const info = await stat(root);
    if (info.isFile()) return { path: root, files: [root], truncated: false };
    if (!info.isDirectory()) throw new Error("path is not a file or directory");
    const files = [];
    await this.walk(root, async full => {
      if (files.length >= maxFiles) return false;
      files.push(full);
      return true;
    });
    return { path: root, files, truncated: files.length >= maxFiles };
  }

  async readFile(inputPath, maxBytes) {
    if (!inputPath) throw new Error("path is required");
    const full = this.resolvePath(inputPath);
    const info = await stat(full);
    if (!info.isFile()) throw new Error("path is not a file");
    if (info.size > maxBytes) throw new Error(`file exceeds max_bytes (${info.size} > ${maxBytes})`);
    const content = await readFile(full, "utf8");
    return { path: full, size: info.size, sha256: sha256(content), content };
  }

  async writeFile(args) {
    if (!this.policy.allowWrite) throw new Error("write_file is disabled by daemon policy");
    if (!args.path) throw new Error("path is required");
    const full = this.resolvePath(args.path);
    if (args.create_only && existsSync(full)) throw new Error("file exists and create_only=true");
    if (args.expected_sha256 && existsSync(full)) {
      const current = await readFile(full, "utf8");
      if (sha256(current) !== args.expected_sha256) throw new Error("expected_sha256 mismatch");
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, String(args.content ?? ""), "utf8");
    const content = await readFile(full, "utf8");
    return { ok: true, path: full, sha256: sha256(content), bytes: Buffer.byteLength(content) };
  }

  async searchText(args) {
    const query = String(args.query || "");
    if (!query) throw new Error("query is required");
    const root = this.resolvePath(args.path || ".");
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
    await this.walk(root, async full => {
      if (matches.length >= max || visitedFiles >= maxFiles) return false;
      visitedFiles += 1;
      await this.searchOneFile(full, query, matches, max);
      return matches.length < max && visitedFiles < maxFiles;
    });
    return { query, root, matches, visited_files: visitedFiles, truncated: matches.length >= max || visitedFiles >= maxFiles };
  }

  async searchOneFile(full, query, matches, max) {
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > 1024 * 1024) return;
    const text = await readFile(full, "utf8").catch(() => "");
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({ path: full, line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= max) break;
      }
    }
  }

  async gitDiff(args) {
    const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, 5 * 1024 * 1024);
    const target = args.path ? this.resolvePath(args.path) : this.workspace;
    const result = await this.runProcess("git", ["-C", this.workspace, "diff", "--", target], 60_000, true, maxBytes);
    return { ...result, path: target };
  }

  async execCommand(command, timeoutSeconds) {
    if (!this.policy.allowExec) throw new Error("exec_command is disabled by daemon policy");
    if (!command || typeof command !== "string") throw new Error("command is required");
    const shell = workspaceShellCommand(command);
    return this.runProcess(shell.cmd, shell.args, clampInt(timeoutSeconds, 120, 1, 600) * 1000);
  }

  async runProcess(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = 512 * 1024) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, { cwd: this.workspace, env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false }) });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = 0;
      let stderrTruncated = 0;
      let timedOut = false;
      let killTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
      const clearTimers = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
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
      child.on("error", error => {
        clearTimers();
        if (allowFailure) resolvePromise({ code: 127, stdout, stderr: error.message });
        else reject(error);
      });
      child.on("close", code => {
        clearTimers();
        const result = { code, stdout: finalizeOutput(stdout, stdoutTruncated), stderr: finalizeOutput(stderr, stderrTruncated) };
        if (timedOut) {
          reject(new Error(`command timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0 || allowFailure) resolvePromise(result);
        else reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
      });
    });
  }

  async walk(root, onFile) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      const entries = await opendir(current).catch(() => null);
      if (!entries) continue;
      for await (const entry of entries) {
        const full = resolve(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          const keepGoing = await onFile(full);
          if (keepGoing === false) return;
        }
      }
    }
  }

  resolvePath(inputPath = ".") {
    const raw = String(inputPath || ".");
    return isAbsolute(raw) ? resolve(raw) : resolve(this.workspace, raw);
  }
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
  const daemon = new LocalDaemon({
    workerUrl: "https://example.invalid",
    secret: "test",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true },
    logger: { info() {}, warn() {}, error() {} },
  });
  const previousSecret = process.env.MBM_DAEMON_SELFTEST_SECRET;
  process.env.MBM_DAEMON_SELFTEST_SECRET = "should-not-leak";
  try {
    await writeFile(join(workspace, ".env"), "SECRET=visible", "utf8");
    await writeFile(join(workspace, "visible.txt"), "needle", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside-needle", "utf8");

    const envFile = await daemon.readFile(".env", 1024);
    if (!envFile.content.includes("SECRET=visible")) throw new Error(".env should be readable by default");

    const outsideFile = await daemon.readFile(join(outside, "outside.txt"), 1024);
    if (!outsideFile.content.includes("outside-needle")) throw new Error("absolute outside path should be readable");

    const parentFile = await daemon.readFile(path.relative(workspace, join(outside, "outside.txt")), 1024);
    if (!parentFile.content.includes("outside-needle")) throw new Error("relative path escaping workspace should be readable");

    const writtenPath = join(outside, "written.txt");
    await daemon.writeFile({ path: writtenPath, content: "written" });
    const written = await readFile(writtenPath, "utf8");
    if (written !== "written") throw new Error("absolute outside path should be writable");

    const cappedSearch = await daemon.searchText({ path: workspace, query: "definitely-not-present", max_files: 1, max_matches: 10 });
    if (cappedSearch.visited_files !== 1 || cappedSearch.truncated !== true) {
      throw new Error("search_text max_files cap did not apply");
    }

    const command = await daemon.execCommand("printf ${MBM_DAEMON_SELFTEST_SECRET-unset}", 5);
    if (command.stdout !== "unset") throw new Error("exec_command inherited unallowlisted environment variables");

    const roots = daemon.listRoots();
    if (!roots.roots.some(root => root.path === workspace)) throw new Error("workspace root missing");
  } finally {
    if (previousSecret === undefined) delete process.env.MBM_DAEMON_SELFTEST_SECRET;
    else process.env.MBM_DAEMON_SELFTEST_SECRET = previousSecret;
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}
