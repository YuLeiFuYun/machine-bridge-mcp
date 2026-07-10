import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import WebSocket from "ws";
import { applyUpdateHunks, parsePatchEnvelope } from "./patch.mjs";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";
import { MAX_COMMAND_BYTES, ProcessSessionManager, terminateProcessTree, validateArgv } from "./process-sessions.mjs";
export { MAX_COMMAND_BYTES } from "./process-sessions.mjs";
import { allToolNames, assertCanonicalFullPolicy, isCanonicalFullPolicy, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, normalizePolicy, POLICY_PROFILES, SERVER_NAME, toolNamesForPolicy } from "./tools.mjs";
import { classifyOperationalError } from "./log.mjs";
import { ManagedJobManager } from "./managed-jobs.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { expandHome } from "./state.mjs";

export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_PATH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SLOW_TOOL_CALL_MS = 30_000;

export class LocalDaemon {
  constructor({ workerUrl = "", secret = "", workspace, policy, logger = console, onSuperseded = null, jobRoot = "", resources = {}, resourceStatePath = "", recoverJobs = true }) {
    this.workerUrl = workerUrl ? normalizeWorkerUrl(workerUrl) : "";
    if (this.workerUrl && (typeof secret !== "string" || secret.length < 16)) throw new Error("daemon secret is missing or too short");
    this.secret = secret || "";
    this.workspaceInput = resolve(workspace || process.cwd());
    this.workspace = realpathSync.native ? realpathSync.native(this.workspaceInput) : realpathSync(this.workspaceInput);
    this.workspaceCanonicalPromise = null;
    this.policy = normalizePolicy(policy);
    this.logger = logger;
    this.onSuperseded = typeof onSuperseded === "function" ? onSuperseded : null;
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.closed = false;
    this.ws = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.connectedOnce = null;
    this.connectedOnceResolve = null;
    this.connectedOnceReject = null;
    this.activeToolCalls = 0;
    this.activeProcesses = new Set();
    this.callProcesses = new Map();
    this.cancelledCalls = new Set();
    this.reconnectAttempt = 0;
    this.mutationQueue = Promise.resolve();
    this.runtimeDir = createRuntimeDir();
    if (typeof jobRoot !== "string" || !jobRoot.trim()) throw new Error("persistent managed-job root is required");
    this.managedJobManager = new ManagedJobManager({
      jobRoot,
      workspace: this.workspace,
      policy: this.policy,
      resources,
      resourceStatePath,
      logger: this.logger,
      recover: recoverJobs,
    });
    this.processSessionManager = new ProcessSessionManager({
      workspace: this.workspace,
      policy: this.policy,
      runtimeDir: this.runtimeDir,
      activeProcesses: this.activeProcesses,
      callProcesses: this.callProcesses,
      resolveCwd: async (input) => {
        const cwd = await this.resolveExistingPath(input);
        if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
        return cwd;
      },
      displayPath: (value) => this.displayPath(value),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
  }

  tools() {
    return toolNamesForPolicy(this.policy).filter((name) => name !== "server_info");
  }

  runtimeInfo() {
    return {
      name: SERVER_NAME,
      protocol_version: MCP_PROTOCOL_VERSION,
      supported_protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
      workspace: this.displayPath(this.workspace),
      workspace_name: basename(this.workspace),
      policy: this.policy,
      policy_contract: {
        named_profile_is_canonical: this.policy.profile === "custom" || policyMatchesNamedProfile(this.policy),
        full_catalog_complete: this.policy.profile === "full" ? isCanonicalFullPolicy(this.policy) && this.tools().length + 1 === allToolNames().length : null,
        machine_bridge_internal_denials_under_full: this.policy.profile === "full" && isCanonicalFullPolicy(this.policy) ? false : null,
      },
      enforcement: {
        filesystem_scope: this.policy.unrestrictedPaths ? "local-user-accessible" : "workspace",
        sensitive_filename_filter: false,
        operating_system_permissions_apply: true,
        host_policy_is_independent: true,
      },
      tools: ["server_info", ...this.tools()],
      observability: {
        per_tool_events: "debug-only",
        default_logs_include_tool_failures: false,
        tool_arguments_or_results_logged: false,
      },
      runtime: {
        environment: this.policy.minimalEnv ? "isolated-minimal" : "full-parent",
        runtime_dir: this.policy.exposeAbsolutePaths ? this.runtimeDir : "<private-runtime-dir>",
        process_sessions: this.processSessionManager.status(),
        managed_jobs: this.managedJobManager.status(),
        local_resources: this.managedJobManager.resourceInfo(),
      },
    };
  }

  start() {
    if (!this.workerUrl || !this.secret) throw new Error("remote daemon start requires a Worker URL and daemon secret");
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
    this.processSessionManager.clear();
    this.reconnectAttempt = 0;
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  connect() {
    if (this.closed) return;
    const wsUrl = `${this.workerUrl.replace(/^http/i, "ws")}/daemon/ws`;
    this.logger.debug?.("connecting to remote relay", { endpoint: redactUrl(wsUrl) });
    const socket = new WebSocket(wsUrl, { headers: { "X-Bridge-Token": this.secret } });
    this.ws = socket;

    socket.on("open", () => {
      if (this.ws !== socket || this.closed) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.logger.info?.("remote relay connected");
      this.send({ type: "hello", tools: this.tools(), policy: this.policy, protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS });
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
        this.logger.error?.("daemon message handler failed", { error_class: classifyOperationalError(error) });
      });
    });

    socket.on("close", (code, reason) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.terminateActiveProcesses("SIGTERM", true);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      const reasonText = String(reason || "").slice(0, 128);
      const fields = { code, reason: reasonText };
      if (isSupersededClose(code, reasonText)) {
        this.closed = true;
        this.terminateActiveProcesses("SIGKILL");
        this.processSessionManager.clear();
        this.logger.warn?.("daemon connection permanently superseded", fields);
        queueMicrotask(() => {
          try { this.onSuperseded?.(); } catch (error) {
            this.logger.error?.("daemon superseded callback failed", { error_class: classifyOperationalError(error) });
          }
        });
        return;
      }
      if (this.closed) this.logger.debug?.("remote relay closed", fields);
      else this.logger.warn?.("remote relay disconnected", fields);
      if (!this.closed) {
        const delay = reconnectDelay(this.reconnectAttempt++);
        this.logger.debug?.("scheduling daemon reconnect", { delay_ms: delay });
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        this.reconnectTimer.unref?.();
      }
    });

    socket.on("error", error => {
      if (this.ws !== socket) return;
      if (this.closed) this.logger.debug?.("remote relay closed during shutdown", { error_class: classifyOperationalError(error) });
      else this.logger.error?.("remote relay error", { error_class: classifyOperationalError(error) });
    });
  }

  send(value) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(value));
      return true;
    } catch (error) {
      this.logger.warn?.("remote relay send failed", { error_class: classifyOperationalError(error) });
      return false;
    }
  }

  async handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch {
      this.logger.warn?.("invalid websocket JSON");
      return;
    }
    if (message.type === "welcome" || message.type === "hello_ack" || message.type === "pong") return;
    if (message.type === "cancel_call") {
      if (typeof message.id === "string") this.cancelCall(message.id, "remote cancellation");
      return;
    }
    if (message.type !== "tool_call") {
      this.logger.warn?.("unknown websocket message", { type: String(message.type || "") });
      return;
    }

    const id = typeof message.id === "string" ? message.id : "";
    const tool = typeof message.tool === "string" ? message.tool : "";
    const argumentsValue = message.arguments === undefined ? {} : message.arguments;
    if (!id || id.length > 256 || !tool || tool.length > 128 || !isPlainRecord(argumentsValue)) {
      this.logger.warn?.("invalid tool_call envelope");
      if (id && id.length <= 256) this.send({ type: "tool_result", id, ok: false, error: { message: "invalid tool_call envelope" } });
      return;
    }
    if (this.activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
      this.send({ type: "tool_result", id, ok: false, error: { message: "too many concurrent tool calls" } });
      return;
    }

    const relayTimeoutMs = clampInt(message.timeout_ms, 60_000, 1000, 610_000);
    const deadline = setTimeout(() => this.cancelCall(id, "relay deadline exceeded"), relayTimeoutMs);
    deadline.unref?.();
    this.activeToolCalls += 1;
    const started = Date.now();
    this.logger.debug?.("tool call started", { call_id: shortCallId(id), tool });
    try {
      const result = await this.executeTool(tool, argumentsValue, { callId: id });
      if (this.cancelledCalls.has(id)) throw new Error("tool call cancelled");
      this.send({ type: "tool_result", id, ok: true, result });
      const durationMs = Date.now() - started;
      this.logger.debug?.(durationMs >= SLOW_TOOL_CALL_MS ? "slow tool call completed" : "tool call completed", { call_id: shortCallId(id), tool, duration_ms: durationMs });
    } catch (error) {
      const safeError = this.safeErrorMessage(error);
      this.send({ type: "tool_result", id, ok: false, error: { message: safeError } });
      const durationMs = Date.now() - started;
      this.logger.debug?.("tool call failed", { call_id: shortCallId(id), tool, duration_ms: durationMs, error_class: classifyOperationalError(error) });
    } finally {
      clearTimeout(deadline);
      this.activeToolCalls -= 1;
      this.finishCall(id);
    }
  }

  finishCall(callId) {
    if (!callId) return;
    this.cancelledCalls.delete(callId);
    this.callProcesses.delete(callId);
  }

  cancelCall(callId, reason = "cancelled") {
    this.cancelledCalls.add(callId);
    this.processSessionManager.notifyCancellation();
    for (const child of this.callProcesses.get(callId) || []) terminateProcessTree(child, "SIGTERM");
    const children = [...(this.callProcesses.get(callId) || [])];
    if (children.length) {
      const timer = setTimeout(() => {
        for (const child of children) if (this.activeProcesses.has(child)) terminateProcessTree(child, "SIGKILL");
      }, 2000);
      timer.unref?.();
    }
    this.logger.debug?.("tool call cancellation requested", { call_id: shortCallId(callId), reason });
  }

  async executeTool(tool, args, context = {}) {
    if (!["server_info", ...this.tools()].includes(tool)) throw new Error(`tool disabled or unknown: ${tool}`);
    switch (tool) {
      case "server_info": return this.runtimeInfo();
      case "project_overview": return this.projectOverview(context);
      case "list_roots": return this.listRoots();
      case "list_dir": return this.listDir(args.path || ".", context);
      case "list_files": return this.listFiles(args.path || ".", clampInt(args.max_files, 1000, 1, 10000), context);
      case "read_file": return this.readFile(args, context);
      case "view_image": return this.viewImage(args, context);
      case "write_file": return this.writeFile(args, context);
      case "edit_file": return this.editFile(args, context);
      case "apply_patch": return this.applyPatch(args, context);
      case "search_text": return this.searchText(args, context);
      case "git_status": return this.gitStatus(args, context);
      case "git_diff": return this.gitDiff(args, context);
      case "git_log": return this.gitLog(args, context);
      case "git_show": return this.gitShow(args, context);
      case "diagnose_runtime": return this.diagnoseRuntime(context);
      case "list_local_resources": return this.managedJobManager.listResources();
      case "generate_ssh_key_resource": return this.generateSshKeyResource(args, context);
      case "stage_job": return this.managedJobManager.stage(args);
      case "start_job": return this.managedJobManager.start(args);
      case "list_jobs": return this.managedJobManager.list(args);
      case "read_job": return this.managedJobManager.read(args);
      case "cancel_job": return this.managedJobManager.cancel(args);
      case "run_process": return this.runDirectProcess(args, context);
      case "start_process": return this.processSessionManager.start(args, context);
      case "read_process": return this.processSessionManager.read(args, context);
      case "write_process": return this.processSessionManager.write(args, context);
      case "kill_process": return this.processSessionManager.kill(args, context);
      case "exec_command": return this.execCommand(args.command, clampInt(args.timeout_seconds, 120, 1, 600), context);
      default: throw new Error(`unknown daemon tool: ${tool}`);
    }
  }

  async projectOverview(context = {}) {
    this.throwIfCancelled(context);
    const top = await this.listDir(".", context).catch(error => ({ error: this.safeErrorMessage(error), entries: [] }));
    const git = await this.runProcess("git", ["-c", "core.fsmonitor=false", "-C", this.workspace, "rev-parse", "--show-toplevel"], 10_000, true, 512 * 1024, context);
    return {
      workspace: this.displayPath(this.workspace),
      workspaceName: basename(this.workspace),
      gitRoot: git.code === 0 ? this.displayPath(git.stdout.trim()) : "",
      policy: this.policy,
      tools: ["server_info", ...this.tools()],
      topLevel: top.entries || [],
    };
  }

  listRoots() {
    const roots = [{ name: basename(this.workspace), path: this.displayPath(this.workspace), default: true }];
    if (this.policy.unrestrictedPaths) {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home && home !== this.workspace) roots.push({ name: "home", path: this.displayPath(resolve(home)), default: false });
      roots.push({ name: "filesystem-root", path: this.displayPath(path.parse(this.workspace).root), default: false });
    }
    return { roots };
  }

  async listDir(inputPath, context = {}) {
    const full = await this.resolveExistingPath(inputPath);
    const entries = [];
    let resultBytes = 0;
    let truncated = false;
    for await (const entry of await opendir(full)) {
      this.throwIfCancelled(context);
      const entryPath = resolve(full, entry.name);
      const info = await lstat(entryPath).catch(() => null);
      const item = {
        name: entry.name,
        path: this.displayPath(entryPath),
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
    return { path: this.displayPath(full), entries, truncated };
  }

  async listFiles(inputPath, maxFiles, context = {}) {
    const root = await this.resolveExistingPath(inputPath);
    const info = await stat(root);
    if (info.isFile()) return { path: this.displayPath(root), files: [this.displayPath(root)], truncated: false };
    if (!info.isDirectory()) throw new Error("path is not a file or directory");
    const files = [];
    let resultBytes = 0;
    const walkResult = await this.walk(root, async full => {
      this.throwIfCancelled(context);
      const shown = this.displayPath(full);
      const pathBytes = Buffer.byteLength(shown) + 8;
      if (files.length >= maxFiles || resultBytes + pathBytes > MAX_PATH_RESULT_BYTES) return false;
      files.push(shown);
      resultBytes += pathBytes;
      return true;
    }, context);
    return { path: this.displayPath(root), files, truncated: files.length >= maxFiles || resultBytes >= MAX_PATH_RESULT_BYTES || walkResult.truncated };
  }

  async readFile(args, context = {}) {
    if (typeof args === "string") {
      args = { path: args, max_bytes: typeof context === "number" ? context : undefined };
      context = {};
    }
    if (!args.path) throw new Error("path is required");
    const full = await this.resolveExistingPath(args.path);
    this.throwIfCancelled(context);
    const { buffer, info } = await readBoundedFile(full, MAX_WRITE_BYTES, "readable text file");
    const content = decodeUtf8(buffer);
    this.throwIfCancelled(context);
    const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, MAX_WRITE_BYTES);
    const startLine = args.start_line === undefined ? 1 : clampInt(args.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
    const rawLines = content.split(/\r?\n/);
    const totalLines = content.endsWith("\n") ? Math.max(1, rawLines.length - 1) : rawLines.length;
    const endLine = args.end_line === undefined ? totalLines : clampInt(args.end_line, totalLines, 1, Number.MAX_SAFE_INTEGER);
    if (endLine < startLine) throw new Error("end_line must be greater than or equal to start_line");
    if (startLine > totalLines) throw new Error(`start_line exceeds total lines (${startLine} > ${totalLines})`);
    const selectedEnd = Math.min(endLine, totalLines);
    let selected = rawLines.slice(startLine - 1, selectedEnd).join("\n");
    if (selectedEnd < totalLines || content.endsWith("\n")) selected += "\n";
    const selectedBytes = Buffer.byteLength(selected);
    if (selectedBytes > maxBytes) throw new Error(`selected content exceeds max_bytes (${selectedBytes} > ${maxBytes})`);
    return {
      path: this.displayPath(full),
      size: info.size,
      sha256: sha256(content),
      content: selected,
      start_line: startLine,
      end_line: selectedEnd,
      total_lines: totalLines,
      complete: startLine === 1 && selectedEnd === totalLines,
    };
  }

  async viewImage(args, context = {}) {
    if (!args.path) throw new Error("path is required");
    const full = await this.resolveExistingPath(args.path);
    this.throwIfCancelled(context);
    const { buffer, info } = await readBoundedFile(full, MAX_IMAGE_BYTES, "image");
    this.throwIfCancelled(context);
    const mimeType = detectImageMime(buffer);
    if (!mimeType) throw new Error("unsupported image format; expected PNG, JPEG, GIF, or WebP");
    return {
      $mcp: {
        content: [{ type: "image", data: buffer.toString("base64"), mimeType }],
        structuredContent: {
          path: this.displayPath(full),
          size: info.size,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          mime_type: mimeType,
        },
      },
    };
  }

  async writeFile(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
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
        if (sha256(current) !== String(args.expected_sha256).toLowerCase()) throw new Error("expected_sha256 mismatch");
      }
      this.throwIfCancelled(context);
      await atomicWriteText(full, content, existing, {
        createOnly: args.create_only === true,
        expectedHash: args.expected_sha256 ? String(args.expected_sha256).toLowerCase() : undefined,
      });
      return { ok: true, path: this.displayPath(full), sha256: sha256(content), bytes };
    });
  }

  async editFile(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
      if (!this.policy.allowWrite) throw new Error("edit_file is disabled by daemon policy");
      if (!args.path) throw new Error("path is required");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!oldText) throw new Error("old_text must not be empty");
      const full = await this.resolveExistingPath(args.path);
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("path is not a regular non-symbolic-link file");
      const current = await readUtf8File(full);
      if (args.expected_sha256 && sha256(current) !== String(args.expected_sha256).toLowerCase()) throw new Error("expected_sha256 mismatch");
      const occurrences = countOccurrences(current, oldText);
      if (occurrences === 0) throw new Error("old_text was not found");
      if (!args.replace_all && occurrences !== 1) throw new Error(`old_text occurs ${occurrences} times; provide a unique fragment or set replace_all=true`);
      const updated = args.replace_all ? current.split(oldText).join(newText) : current.replace(oldText, newText);
      const bytes = Buffer.byteLength(updated);
      if (bytes > MAX_WRITE_BYTES) throw new Error(`edited content exceeds maximum write size (${bytes} > ${MAX_WRITE_BYTES})`);
      this.throwIfCancelled(context);
      await atomicWriteText(full, updated, info, { expectedHash: sha256(current) });
      return { ok: true, path: this.displayPath(full), replacements: args.replace_all ? occurrences : 1, sha256: sha256(updated), bytes };
    });
  }

  async applyPatch(args, context = {}) {
    return this.withMutationLock(async () => {
      this.throwIfCancelled(context);
      if (!this.policy.allowWrite) throw new Error("apply_patch is disabled by daemon policy");
      const patchText = String(args.patch ?? "");
      if (!patchText) throw new Error("patch is required");
      if (Buffer.byteLength(patchText) > MAX_WRITE_BYTES) throw new Error("patch exceeds maximum size");
      const parsed = parsePatchEnvelope(patchText);
      const prepared = [];
      for (const operation of parsed) {
        this.throwIfCancelled(context);
        if (operation.kind === "add") {
          const target = await this.resolveWritePath(operation.path);
          if (await lstat(target).catch(() => null)) throw new Error(`add target already exists: ${operation.path}`);
          assertTextSize(operation.content, operation.path);
          prepared.push({ kind: "add", source: null, target, content: operation.content, mode: 0o600 });
          continue;
        }
        const source = await this.resolveExistingPath(operation.path);
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`patch source is not a regular file: ${operation.path}`);
        const original = await readUtf8File(source);
        if (operation.kind === "delete") {
          prepared.push({ kind: "delete", source, target: null, originalHash: sha256(original), mode: sourceInfo.mode & 0o777 });
          continue;
        }
        const content = applyUpdateHunks(original, operation.hunks, operation.path);
        assertTextSize(content, operation.path);
        const target = operation.moveTo ? await this.resolveWritePath(operation.moveTo) : source;
        if (target !== source && await lstat(target).catch(() => null)) throw new Error(`move target already exists: ${operation.moveTo}`);
        prepared.push({ kind: operation.moveTo ? "move" : "update", source, target, content, originalHash: sha256(original), mode: sourceInfo.mode & 0o777 });
      }
      assertNoResolvedPatchCollisions(prepared);
      this.throwIfCancelled(context);
      await commitPatchTransaction(prepared);
      return {
        ok: true,
        files: prepared.map((item) => ({
          operation: item.kind,
          path: this.displayPath(item.target || item.source),
          from: item.kind === "move" ? this.displayPath(item.source) : undefined,
          sha256: item.content === undefined ? undefined : sha256(item.content),
        })),
      };
    });
  }

  async searchText(args, context = {}) {
    const query = String(args.query || "");
    if (!query) throw new Error("query is required");
    const root = await this.resolveExistingPath(args.path || ".");
    const max = clampInt(args.max_matches, 100, 1, 1000);
    const maxFiles = clampInt(args.max_files, 10000, 1, 100000);
    let visitedFiles = 0;
    const matches = [];
    const rootInfo = await stat(root);
    if (rootInfo.isFile()) {
      await this.searchOneFile(root, query, matches, max, context);
      return { query, root: this.displayPath(root), matches, visited_files: 1, truncated: matches.length >= max };
    }
    if (!rootInfo.isDirectory()) throw new Error("path is not a file or directory");
    const walkResult = await this.walk(root, async full => {
      this.throwIfCancelled(context);
      if (matches.length >= max || visitedFiles >= maxFiles) return false;
      visitedFiles += 1;
      await this.searchOneFile(full, query, matches, max, context);
      return matches.length < max && visitedFiles < maxFiles;
    }, context);
    return { query, root: this.displayPath(root), matches, visited_files: visitedFiles, truncated: matches.length >= max || visitedFiles >= maxFiles || walkResult.truncated };
  }

  async searchOneFile(full, query, matches, max, context = {}) {
    this.throwIfCancelled(context);
    const bounded = await readBoundedFile(full, 1024 * 1024, "search file").catch(() => null);
    if (!bounded || bounded.buffer.includes(0)) return;
    const buffer = bounded.buffer;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return; }
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({ path: this.displayPath(full), line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= max) break;
      }
    }
  }

  async gitStatus(args = {}, context = {}) {
    const git = await this.gitContext(args.path || ".", context);
    if (!git.ok) return git.result;
    const commandArgs = ["-c", "core.fsmonitor=false", "-C", git.root, "status", "--short", "--branch"];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 30_000, true, 512 * 1024, context);
    return { ...result, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async gitDiff(args = {}, context = {}) {
    const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, MAX_WRITE_BYTES);
    const git = await this.gitContext(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const commandArgs = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", git.root, "diff", "--no-ext-diff", "--no-textconv"];
    if (args.staged) commandArgs.push("--cached");
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 60_000, true, maxBytes, context);
    return { ...result, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root), staged: args.staged === true };
  }

  async gitLog(args = {}, context = {}) {
    const git = await this.gitContext(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const maxCount = clampInt(args.max_count, 20, 1, 100);
    const format = "%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e";
    const commandArgs = ["-c", "core.fsmonitor=false", "-C", git.root, "log", `--max-count=${maxCount}`, `--format=${format}`];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 30_000, true, 1024 * 1024, context);
    const commits = result.stdout.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [hash, short, authored_at, author_name, author_email, subject] = record.split("\x1f");
      const commit = { hash, short, authored_at, author_name, subject };
      if (args.include_author_email === true) commit.author_email = author_email;
      return commit;
    });
    return { code: result.code, stderr: result.stderr, commits, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async gitShow(args = {}, context = {}) {
    const git = await this.gitContext(args.path || ".", context);
    if (!git.ok) return { ...git.result, path: this.displayPath(git.target) };
    const revision = validateRevision(args.revision || "HEAD");
    const maxBytes = clampInt(args.max_bytes, 1024 * 1024, 1, MAX_WRITE_BYTES);
    const commandArgs = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", git.root, "show", "--no-ext-diff", "--no-textconv", "--decorate=no", revision];
    if (git.pathspec) commandArgs.push("--", git.pathspec);
    const result = await this.runProcess("git", commandArgs, 60_000, true, maxBytes, context);
    return { ...result, revision, path: this.displayPath(git.target), gitRoot: this.displayPath(git.root) };
  }

  async gitContext(inputPath, context = {}) {
    const target = await this.resolveExistingPath(inputPath);
    const info = await stat(target);
    const cwd = info.isDirectory() ? target : dirname(target);
    const result = await this.runProcess("git", ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--show-toplevel"], 10_000, true, 512 * 1024, context);
    if (result.code !== 0) return { ok: false, result, target };
    const root = result.stdout.trim();
    const repoRelative = relative(root, target);
    if (repoRelative.startsWith(`..${sep}`) || repoRelative === ".." || isAbsolute(repoRelative)) {
      return { ok: false, target, result: { code: 128, stdout: "", stderr: "target is outside the detected git repository" } };
    }
    return { ok: true, target, root, pathspec: repoRelative || "" };
  }

  async diagnoseRuntime(context = {}) {
    this.throwIfCancelled(context);
    const checks = [];
    checks.push({
      layer: "mcp-host-to-daemon",
      ok: true,
      detail: "This diagnostic request reached the local Machine Bridge runtime.",
    });
    checks.push({
      layer: "machine-bridge-policy",
      ok: this.policy.execMode === "direct" || this.policy.execMode === "shell",
      detail: `profile=${this.policy.profile}; exec_mode=${this.policy.execMode}; unrestricted_paths=${this.policy.unrestrictedPaths}`,
    });

    const probe = join(this.runtimeDir, `.diagnostic-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      await writeFile(probe, "ok\n", { mode: 0o600, flag: "wx" });
      const { buffer } = await readBoundedFile(probe, 64, "diagnostic file");
      checks.push({ layer: "local-filesystem", ok: buffer.toString("utf8") === "ok\n", error_class: null });
    } catch (error) {
      checks.push({ layer: "local-filesystem", ok: false, error_class: classifyOperationalError(error) });
    } finally {
      await rm(probe, { force: true }).catch(() => {});
    }

    if (this.policy.execMode === "direct" || this.policy.execMode === "shell") {
      const direct = await this.runProcess(
        process.execPath,
        ["-e", "process.stdout.write('ok')"],
        5000,
        true,
        1024,
        context,
        this.workspace,
      ).catch((error) => ({ code: 127, stdout: "", stderr: "", error_class: classifyOperationalError(error) }));
      checks.push({
        layer: "local-process-spawn",
        ok: direct.code === 0 && direct.stdout === "ok",
        error_class: direct.error_class || (direct.code === 0 ? null : classifyOperationalError(direct.stderr || direct.stdout || "execution failed")),
      });
    } else {
      checks.push({ layer: "local-process-spawn", ok: false, skipped: true, error_class: "policy_denied" });
    }

    if (this.policy.execMode === "shell") {
      const shell = workspaceShellCommand(process.platform === "win32" ? "cd" : "pwd");
      const result = await this.runProcess(shell.cmd, shell.args, 5000, true, 4096, context, this.workspace)
        .catch((error) => ({ code: 127, error_class: classifyOperationalError(error) }));
      checks.push({
        layer: "local-shell",
        ok: result.code === 0,
        error_class: result.error_class || (result.code === 0 ? null : classifyOperationalError(result.stderr || result.stdout || "execution failed")),
      });
    } else {
      checks.push({ layer: "local-shell", ok: false, skipped: true, error_class: "policy_denied" });
    }

    const storage = this.managedJobManager.diagnoseStorage();
    checks.push({ layer: "managed-job-storage", ...storage });
    const resources = this.managedJobManager.listResources();
    checks.push({
      layer: "local-resource-registry",
      ok: resources.resources.every((resource) => resource.available),
      registered: resources.count,
      unavailable: resources.resources.filter((resource) => !resource.available).map((resource) => ({ name: resource.name, error_class: resource.error_class })),
    });

    return {
      request_reached_local_runtime: true,
      interpretation: {
        tool_call_blocked_before_response: "host/platform or connector gateway",
        diagnostic_reached_daemon_but_spawn_failed: "local OS, endpoint security, shell configuration, or Machine Bridge policy",
        managed_job_accepted_then_later_tools_blocked: "job continues independently; inspect with local CLI or a later read_job call",
      },
      policy: this.policy,
      checks,
      ok: checks.filter((check) => !check.skipped).every((check) => check.ok),
    };
  }

  async generateSshKeyResource(args = {}, context = {}) {
    this.throwIfCancelled(context);
    assertCanonicalFullPolicy(this.policy);
    if (!this.resourceStatePath) throw new Error("local resource state is unavailable in this runtime");
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw new Error("HOME or USERPROFILE is required to choose a default SSH key path");
    const target = args.path
      ? resolve(expandHome(String(args.path)))
      : resolve(home, ".ssh", `machine-mcp-${args.name}-ed25519`);
    const key = await generateRegisteredSshKey({
      workspace: this.workspace,
      stateDir: stateRootFromProfileStatePath(this.resourceStatePath),
      name: args.name,
      targetPath: target,
      comment: args.comment || `machine-mcp:${args.name}`,
    });
    return {
      name: key.name,
      created: key.created,
      registered: key.registered,
      private_key_path: this.displayPath(key.privateKeyPath),
      public_key_path: this.displayPath(key.publicKeyPath),
      fingerprint: key.fingerprint,
      key_type: key.keyType,
      private_mode: key.privateMode,
      public_mode: key.publicMode,
      private_key_content_exposed: key.privateKeyContentExposed,
      available_to_new_jobs_immediately: key.availableToNewJobsImmediately,
    };
  }

  async runDirectProcess(args, context = {}) {
    if (this.policy.execMode !== "direct" && this.policy.execMode !== "shell") throw new Error("run_process is disabled by daemon policy");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveExistingPath(args.cwd || ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    return this.runProcess(argv[0], argv.slice(1), clampInt(args.timeout_seconds, 120, 1, 600) * 1000, false, 512 * 1024, context, cwd);
  }

  async execCommand(command, timeoutSeconds, context = {}) {
    if (this.policy.execMode !== "shell") throw new Error("exec_command requires shell execution mode");
    if (!command || typeof command !== "string") throw new Error("command is required");
    if (command.includes("\0")) throw new Error("command contains a NUL byte");
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error(`command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
    const shell = workspaceShellCommand(command);
    return this.runProcess(shell.cmd, shell.args, clampInt(timeoutSeconds, 120, 1, 600) * 1000, false, 512 * 1024, context);
  }

  terminateActiveProcesses(signal = "SIGTERM", escalate = false) {
    const children = [...this.activeProcesses];
    for (const child of children) terminateProcessTree(child, signal);
    if (escalate && signal !== "SIGKILL" && children.length) {
      const timer = setTimeout(() => {
        for (const child of children) if (this.activeProcesses.has(child)) terminateProcessTree(child, "SIGKILL");
      }, 2000);
      timer.unref?.();
    }
  }

  async runProcess(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = 512 * 1024, context = {}, cwd = this.workspace) {
    this.throwIfCancelled(context);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: executionEnv(this.workspace, { fullEnv: this.policy.minimalEnv === false, runtimeDir: this.runtimeDir }),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.activeProcesses.add(child);
      if (context.callId) {
        const set = this.callProcesses.get(context.callId) || new Set();
        set.add(child);
        this.callProcesses.set(context.callId, set);
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
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2000);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer && !timedOut) clearTimeout(killTimer);
        this.activeProcesses.delete(child);
        if (context.callId) {
          const set = this.callProcesses.get(context.callId);
          set?.delete(child);
          if (!set?.size) this.callProcesses.delete(context.callId);
        }
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
        if (context.callId && this.cancelledCalls.has(context.callId)) {
          reject(new Error("tool call cancelled"));
          return;
        }
        if (timedOut) {
          reject(new Error(`command timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0 || allowFailure) resolvePromise(result);
        else reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
      }));
    });
  }

  async walk(root, onFile, context = {}) {
    const stack = [root];
    let visitedEntries = 0;
    while (stack.length) {
      this.throwIfCancelled(context);
      const current = stack.pop();
      const entries = await opendir(current).catch(() => null);
      if (!entries) continue;
      for await (const entry of entries) {
        this.throwIfCancelled(context);
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
    return isAbsolute(raw) ? resolve(raw) : resolve(this.workspaceInput, raw);
  }

  async canonicalWorkspace() {
    if (!this.workspaceCanonicalPromise) {
      this.workspaceCanonicalPromise = realpath(this.workspaceInput).then((canonical) => {
        this.workspace = canonical;
        this.processSessionManager.workspace = canonical;
        return canonical;
      }).catch((error) => {
        this.workspaceCanonicalPromise = null;
        throw error;
      });
    }
    return this.workspaceCanonicalPromise;
  }

  async resolveExistingPath(inputPath = ".") {
    const candidate = this.resolvePath(inputPath);
    const [workspace, canonical] = await Promise.all([this.canonicalWorkspace(), realpath(candidate)]);
    if (!this.policy.unrestrictedPaths) assertContainedPath(workspace, canonical);
    return canonical;
  }

  async resolveWritePath(inputPath = ".") {
    const candidate = this.resolvePath(inputPath);
    if (this.policy.unrestrictedPaths) return candidate;
    const candidateInfo = await lstat(candidate).catch(() => null);
    let ancestor = candidate;
    while (!(await lstat(ancestor).catch(() => null))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const [workspace, canonicalAncestor] = await Promise.all([this.canonicalWorkspace(), realpath(ancestor)]);
    assertContainedPath(workspace, canonicalAncestor);
    if (candidateInfo?.isSymbolicLink()) throw new Error("refusing to overwrite a symbolic link");
    const suffix = relative(ancestor, candidate);
    return suffix ? resolve(canonicalAncestor, suffix) : canonicalAncestor;
  }

  displayPath(fullPath) {
    const absolute = resolve(fullPath);
    if (this.policy.exposeAbsolutePaths || this.policy.unrestrictedPaths) return absolute;
    assertContainedPath(this.workspace, absolute);
    const shown = relative(this.workspace, absolute);
    return shown ? shown.split(sep).join("/") : ".";
  }

  safeErrorMessage(error) {
    let message = boundedErrorMessage(error);
    if (!this.policy.exposeAbsolutePaths) {
      for (const prefix of equivalentPathPrefixes(this.workspace, this.workspaceInput)) message = replacePathPrefix(message, prefix, ".");
      for (const prefix of equivalentPathPrefixes(this.runtimeDir)) message = replacePathPrefix(message, prefix, "<runtime>");
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) message = replacePathPrefix(message, resolve(home), "<home>");
    }
    return message;
  }

  throwIfCancelled(context = {}) {
    if (context.callId && this.cancelledCalls.has(context.callId)) throw new Error("tool call cancelled");
  }

  async withMutationLock(callback) {
    const previous = this.mutationQueue;
    let release = () => {};
    this.mutationQueue = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await callback(); } finally { release(); }
  }
}

function policyMatchesNamedProfile(policy) {
  const named = POLICY_PROFILES[policy.profile];
  if (!named) return false;
  return policy.allowWrite === named.allowWrite
    && policy.execMode === named.execMode
    && policy.unrestrictedPaths === named.unrestrictedPaths
    && policy.minimalEnv === named.minimalEnv
    && policy.exposeAbsolutePaths === named.exposeAbsolutePaths;
}

function stateRootFromProfileStatePath(statePath) {
  const absolute = resolve(statePath);
  if (basename(absolute) !== "state.json") throw new Error("local resource state path is invalid");
  const profileDir = dirname(absolute);
  const profilesDir = dirname(profileDir);
  if (basename(profilesDir) !== "profiles") throw new Error("local resource state path is outside the expected profile layout");
  return dirname(profilesDir);
}

function normalizeWorkerUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("invalid Worker URL"); }
  if (url.protocol !== "https:") throw new Error("Worker URL must use HTTPS");
  if (url.username || url.password) throw new Error("Worker URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Worker URL must be an origin without a path, query, or fragment");
  return url.origin;
}

export function isSupersededClose(code, reason) {
  return Number(code) === 1012 && String(reason || "") === "replaced by authenticated daemon";
}

function reconnectDelay(attempt) {
  const base = Math.min(3000 * (2 ** Math.min(attempt, 4)), 60_000);
  return base + Math.floor(Math.random() * 1000);
}


function assertContainedPath(root, target) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("path is outside the configured workspace; restart with --unrestricted-paths to allow it");
}

async function readBoundedFile(filePath, maxBytes, label) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > maxBytes) throw new Error(`${label} exceeds maximum size (${info.size} > ${maxBytes})`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { buffer: buffer.subarray(0, offset), info };
  } finally {
    await handle.close();
  }
}

function decodeUtf8(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    throw new Error("file is not valid UTF-8 text");
  }
}

async function readUtf8File(filePath) {
  const { buffer } = await readBoundedFile(filePath, MAX_WRITE_BYTES, "text file");
  return decodeUtf8(buffer);
}

async function atomicWriteText(full, content, existing = null, options = {}) {
  await mkdir(dirname(full), { recursive: true });
  const temp = join(dirname(full), `.${basename(full)}.mbm-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: existing ? existing.mode & 0o777 : 0o600 });
    if (existing) await chmod(temp, existing.mode & 0o777).catch(() => {});
    if (options.expectedHash) {
      const current = await readUtf8File(full).catch(() => null);
      if (current === null || sha256(current) !== options.expectedHash) throw new Error("file changed before atomic commit");
    }
    if (options.createOnly) {
      await link(temp, full);
      await rm(temp, { force: true });
    } else {
      await rename(temp, full);
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function assertNoResolvedPatchCollisions(operations) {
  const owners = new Map();
  for (const operation of operations) {
    const paths = operation.source === operation.target
      ? [operation.source]
      : [operation.source, operation.target].filter(Boolean);
    for (const full of paths) {
      const key = process.platform === "win32" ? String(full).toLowerCase() : String(full);
      const previous = owners.get(key);
      if (previous && previous !== operation) throw new Error(`patch operations resolve to the same path: ${full}`);
      owners.set(key, operation);
    }
  }
}

async function commitPatchTransaction(operations) {
  const staged = [];
  const committed = [];
  try {
    for (const operation of operations) {
      if (operation.content === undefined) continue;
      await mkdir(dirname(operation.target), { recursive: true });
      const temp = join(dirname(operation.target), `.${basename(operation.target)}.mbm-patch-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
      await writeFile(temp, operation.content, { encoding: "utf8", flag: "wx", mode: operation.mode });
      await chmod(temp, operation.mode).catch(() => {});
      staged.push({ operation, temp });
    }

    for (const operation of operations) {
      if (operation.source) {
        const current = await readUtf8File(operation.source);
        if (sha256(current) !== operation.originalHash) throw new Error(`patch source changed during apply: ${operation.source}`);
      }
      if (operation.kind === "add" || operation.kind === "move") {
        if (await lstat(operation.target).catch(() => null)) throw new Error(`patch target appeared during apply: ${operation.target}`);
      }
    }

    for (const operation of operations) {
      let backup = null;
      if (operation.source) {
        backup = join(dirname(operation.source), `.${basename(operation.source)}.mbm-backup-${process.pid}-${randomBytes(6).toString("hex")}`);
        await rename(operation.source, backup);
      }
      const record = { operation, backup, targetCreated: false };
      committed.push(record);
      const stage = staged.find((item) => item.operation === operation);
      if (stage) {
        await rename(stage.temp, operation.target);
        record.targetCreated = true;
      }
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      if (item.targetCreated) await rm(item.operation.target, { force: true }).catch(() => {});
      if (item.backup) await rename(item.backup, item.operation.source).catch(() => {});
    }
    throw error;
  } finally {
    for (const item of staged) await rm(item.temp, { force: true }).catch(() => {});
  }
  for (const item of committed) if (item.backup) await rm(item.backup, { force: true }).catch(() => {});
}

function assertTextSize(content, label) {
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_WRITE_BYTES) throw new Error(`patched file exceeds maximum size for ${label} (${bytes} > ${MAX_WRITE_BYTES})`);
}

function countOccurrences(content, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateRevision(value) {
  const revision = String(value || "HEAD");
  if (!revision || revision.length > 256 || revision.startsWith("-") || revision.includes("\0") || /[\r\n]/.test(revision)) throw new Error("invalid Git revision");
  return revision;
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

function createRuntimeDir() {
  const root = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-"));
  for (const name of ["home", "tmp", "cache"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function equivalentPathPrefixes(...values) {
  const prefixes = new Set(values.filter(Boolean).map((value) => String(value)));
  for (const value of [...prefixes]) {
    if (value.startsWith("/private/")) prefixes.add(value.slice("/private".length));
    else if (value.startsWith("/") && ["/var/", "/tmp/", "/etc/"].some((prefix) => value.startsWith(prefix))) prefixes.add(`/private${value}`);
  }
  return [...prefixes].sort((left, right) => right.length - left.length);
}

function replacePathPrefix(message, pathValue, replacement) {
  if (!pathValue) return message;
  const normalized = String(pathValue);
  return message.split(normalized).join(replacement);
}

function shortCallId(value) {
  return String(value || "").slice(0, 20);
}

function redactUrl(value) {
  try { return new URL(value).origin; } catch { return "<invalid-url>"; }
}
