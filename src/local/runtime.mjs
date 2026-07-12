import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RelayConnection } from "./relay-connection.mjs";
import { applyUpdateHunks, parsePatchEnvelope } from "./patch.mjs";
import { executionEnv, workspaceShellCommand } from "./shell.mjs";
import { MAX_COMMAND_BYTES, ProcessSessionManager, terminateProcessTree, validateArgv } from "./process-sessions.mjs";
export { MAX_COMMAND_BYTES } from "./process-sessions.mjs";
import { allToolNames, assertCanonicalFullPolicy, isCanonicalFullPolicy, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, normalizePolicy, POLICY_PROFILES, SERVER_NAME, toolNamesForPolicy } from "./tools.mjs";
import { classifyOperationalError } from "./log.mjs";
import { ManagedJobManager } from "./managed-jobs.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { expandHome } from "./state.mjs";
import { AgentContextManager } from "./agent-context.mjs";

export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 16;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_PATH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SLOW_TOOL_CALL_MS = 30_000;

const RUNTIME_TOOL_HANDLERS = Object.freeze({
  server_info: (runtime) => runtime.runtimeInfo(),
  project_overview: (runtime, _args, context) => runtime.projectOverview(context),
  agent_context: (runtime, args, context) => runtime.agentContextManager.agentContext(args, context),
  list_local_skills: (runtime, args, context) => runtime.agentContextManager.listLocalSkills(args, context),
  load_local_skill: (runtime, args, context) => runtime.agentContextManager.loadLocalSkill(args, context),
  list_local_commands: (runtime, args, context) => runtime.agentContextManager.listLocalCommands(args, context),
  run_local_command: (runtime, args, context) => runtime.runLocalCommand(args, context),
  list_roots: (runtime) => runtime.listRoots(),
  list_dir: (runtime, args, context) => runtime.listDir(args.path || ".", context),
  list_files: (runtime, args, context) => runtime.listFiles(args.path || ".", clampInt(args.max_files, 1000, 1, 10000), context),
  read_file: (runtime, args, context) => runtime.readFile(args, context),
  view_image: (runtime, args, context) => runtime.viewImage(args, context),
  write_file: (runtime, args, context) => runtime.writeFile(args, context),
  edit_file: (runtime, args, context) => runtime.editFile(args, context),
  apply_patch: (runtime, args, context) => runtime.applyPatch(args, context),
  search_text: (runtime, args, context) => runtime.searchText(args, context),
  git_status: (runtime, args, context) => runtime.gitStatus(args, context),
  git_diff: (runtime, args, context) => runtime.gitDiff(args, context),
  git_log: (runtime, args, context) => runtime.gitLog(args, context),
  git_show: (runtime, args, context) => runtime.gitShow(args, context),
  diagnose_runtime: (runtime, _args, context) => runtime.diagnoseRuntime(context),
  list_local_resources: (runtime) => runtime.managedJobManager.listResources(),
  generate_ssh_key_resource: (runtime, args, context) => runtime.generateSshKeyResource(args, context),
  stage_job: (runtime, args) => runtime.managedJobManager.stage(args),
  start_job: (runtime, args) => runtime.managedJobManager.start(args),
  list_jobs: (runtime, args) => runtime.managedJobManager.list(args),
  read_job: (runtime, args) => runtime.managedJobManager.read(args),
  cancel_job: (runtime, args) => runtime.managedJobManager.cancel(args),
  run_process: (runtime, args, context) => runtime.runDirectProcess(args, context),
  start_process: (runtime, args, context) => runtime.processSessionManager.start(args, context),
  read_process: (runtime, args, context) => runtime.processSessionManager.read(args, context),
  write_process: (runtime, args, context) => runtime.processSessionManager.write(args, context),
  kill_process: (runtime, args, context) => runtime.processSessionManager.kill(args, context),
  exec_command: (runtime, args, context) => runtime.execCommand(args.command, clampInt(args.timeout_seconds, 120, 1, 600), context),
});

export function runtimeToolHandlerNames() {
  return Object.keys(RUNTIME_TOOL_HANDLERS);
}

export class LocalRuntime {
  constructor({ workerUrl = "", secret = "", expectedRelayVersion = "", workspace, policy, logger = console, onSuperseded = null, onFatal = null, jobRoot = "", resources = {}, resourceStatePath = "", recoverJobs = true }) {
    const remoteWorkerUrl = workerUrl ? String(workerUrl) : "";
    const remoteSecret = secret || "";
    this.workspaceInput = resolve(workspace || process.cwd());
    this.workspace = realpathSync.native ? realpathSync.native(this.workspaceInput) : realpathSync(this.workspaceInput);
    this.workspaceCanonicalPromise = null;
    this.policy = normalizePolicy(policy);
    this.logger = logger;
    this.onSuperseded = typeof onSuperseded === "function" ? onSuperseded : null;
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.activeToolCalls = 0;
    this.activeProcesses = new Set();
    this.callProcesses = new Map();
    this.cancelledCalls = new Set();
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
    this.agentContextManager = new AgentContextManager({
      workspace: this.workspace,
      policy: this.policy,
      displayPath: (value) => this.displayPath(value),
      resolveExistingPath: (value) => this.resolveExistingPath(value),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.relay = createRelayConnection(this, {
      workerUrl: remoteWorkerUrl,
      secret: remoteSecret,
      expectedVersion: expectedRelayVersion,
      onFatal,
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
      workspace_name: this.policy.exposeAbsolutePaths ? basename(this.workspace) : "workspace",
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
      tool_delivery: {
        full_profile_scope: "local-daemon-and-relay-advertisement",
        daemon_advertised_tool_count: this.tools().length + 1,
        host_exposed_tools_known_to_server: false,
        host_may_expose_subset: true,
      },
      tools: ["server_info", ...this.tools()],
      observability: {
        relay_readiness: "authenticated-hello-acknowledged",
        brief_relay_interruptions: "debug-only",
        raw_transport_details: "debug-only",
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
    if (!this.relay) throw new Error("remote daemon start requires a Worker URL and daemon secret");
    return this.relay.start();
  }

  stop() {
    this.relay?.stop();
    this.terminateActiveProcesses("SIGKILL");
    this.processSessionManager.clear();
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }

  send(value) {
    return this.relay?.send(value) === true;
  }

  async handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch {
      this.handleRelayProtocolViolation("invalid_server_json");
      return;
    }
    if (!isPlainRecord(message)) {
      this.handleRelayProtocolViolation("invalid_server_message");
      return;
    }
    if (this.handleRelayControlMessage(message)) return;
    if (message.type !== "tool_call") {
      this.handleRelayProtocolViolation("unexpected_server_message_type");
      return;
    }
    await this.handleRelayToolCall(message);
  }

  handleRelayControlMessage(message) {
    if (message.type === "welcome") {
      this.relay?.observeWelcome(message);
      return true;
    }
    if (message.type === "hello_ack") {
      this.relay?.acknowledge(message);
      return true;
    }
    if (message.type === "pong") return true;
    if (message.type === "error") {
      this.relay?.handleServerError(message);
      return true;
    }
    if (message.type === "cancel_call") {
      if (typeof message.id === "string") this.cancelCall(message.id, "remote cancellation");
      return true;
    }
    return false;
  }

  handleRelayProtocolViolation(errorCode) {
    if (this.relay) {
      this.relay.handleServerError({ type: "error", error: errorCode });
      return;
    }
    this.logger.error?.("remote relay protocol error; upgrade and redeploy both components, then restart the daemon");
  }

  async handleRelayToolCall(message) {
    const envelope = normalizeRelayToolCall(message);
    if (!envelope.ok) {
      this.logger.warn?.("invalid tool_call envelope");
      if (envelope.id) this.send({ type: "tool_result", id: envelope.id, ok: false, error: { message: "invalid tool_call envelope" } });
      return;
    }
    if (this.activeToolCalls >= MAX_CONCURRENT_TOOL_CALLS) {
      this.send({ type: "tool_result", id: envelope.id, ok: false, error: { message: "too many concurrent tool calls" } });
      return;
    }

    const deadline = setTimeout(() => this.cancelCall(envelope.id, "relay deadline exceeded"), envelope.timeoutMs);
    deadline.unref?.();
    this.activeToolCalls += 1;
    const started = Date.now();
    this.logger.debug?.("tool call started", { call_id: shortCallId(envelope.id), tool: envelope.tool });
    try {
      const result = await this.executeTool(envelope.tool, envelope.arguments, { callId: envelope.id });
      if (this.cancelledCalls.has(envelope.id)) throw new Error("tool call cancelled");
      this.send({ type: "tool_result", id: envelope.id, ok: true, result });
      const durationMs = Date.now() - started;
      this.logger.debug?.(durationMs >= SLOW_TOOL_CALL_MS ? "slow tool call completed" : "tool call completed", { call_id: shortCallId(envelope.id), tool: envelope.tool, duration_ms: durationMs });
    } catch (error) {
      const safeError = this.safeErrorMessage(error, envelope.arguments);
      this.send({ type: "tool_result", id: envelope.id, ok: false, error: { message: safeError } });
      const durationMs = Date.now() - started;
      this.logger.debug?.("tool call failed", { call_id: shortCallId(envelope.id), tool: envelope.tool, duration_ms: durationMs, error_class: classifyOperationalError(error) });
    } finally {
      clearTimeout(deadline);
      this.activeToolCalls -= 1;
      this.finishCall(envelope.id);
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
    const handler = RUNTIME_TOOL_HANDLERS[tool];
    if (!handler) throw new Error(`runtime handler is missing for tool: ${tool}`);
    return handler(this, args, context);
  }

  async projectOverview(context = {}) {
    this.throwIfCancelled(context);
    const top = await this.listDir(".", context).catch(error => ({ error: this.safeErrorMessage(error), entries: [] }));
    const git = await this.runProcess("git", ["-c", "core.fsmonitor=false", "-C", this.workspace, "rev-parse", "--show-toplevel"], 10_000, true, 512 * 1024, context);
    return {
      workspace: this.displayPath(this.workspace),
      workspaceName: this.policy.exposeAbsolutePaths ? basename(this.workspace) : "workspace",
      gitRoot: git.code === 0 ? this.displayPath(git.stdout.trim()) : "",
      policy: this.policy,
      tools: ["server_info", ...this.tools()],
      topLevel: top.entries || [],
    };
  }

  listRoots() {
    const roots = [{ name: this.policy.exposeAbsolutePaths ? basename(this.workspace) : "workspace", path: this.displayPath(this.workspace), default: true }];
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
    const exposePaths = args.expose_paths === true;
    return {
      name: key.name,
      created: key.created,
      registered: key.registered,
      fingerprint: key.fingerprint,
      key_type: key.keyType,
      private_mode: key.privateMode,
      public_mode: key.publicMode,
      private_key_content_exposed: key.privateKeyContentExposed,
      available_to_new_jobs_immediately: key.availableToNewJobsImmediately,
      paths_exposed: exposePaths,
      ...(exposePaths ? {
        private_key_path: resolve(key.privateKeyPath),
        public_key_path: resolve(key.publicKeyPath),
      } : {}),
    };
  }

  async runDirectProcess(args, context = {}) {
    if (this.policy.execMode !== "direct" && this.policy.execMode !== "shell") throw new Error("run_process is disabled by daemon policy");
    const argv = validateArgv(args.argv);
    const cwd = await this.resolveExistingPath(args.cwd || ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    return this.runProcess(argv[0], argv.slice(1), clampInt(args.timeout_seconds, 120, 1, 600) * 1000, false, 512 * 1024, context, cwd);
  }

  async runLocalCommand(args, context = {}) {
    if (this.policy.execMode !== "direct" && this.policy.execMode !== "shell") throw new Error("run_local_command is disabled by daemon policy");
    const command = await this.agentContextManager.resolveLocalCommand(args, context);
    const argv = validateArgv(command.argv);
    const cwd = await this.resolveExistingPath(command.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("registered command cwd is not a directory");
    const requestedTimeout = args.timeout_seconds === undefined
      ? command.timeoutSeconds
      : clampInt(args.timeout_seconds, command.timeoutSeconds, 1, 600);
    const timeoutSeconds = Math.min(requestedTimeout, command.timeoutSeconds);
    const result = await this.runProcess(argv[0], argv.slice(1), timeoutSeconds * 1000, false, 512 * 1024, context, cwd);
    return {
      name: command.name,
      cwd: this.displayPath(cwd),
      timeout_seconds: timeoutSeconds,
      ...result,
    };
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
        if (killTimer) clearTimeout(killTimer);
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
    if (this.policy.exposeAbsolutePaths) return absolute;
    const shown = relative(this.workspace, absolute);
    const insideWorkspace = shown === "" || (!shown.startsWith(`..${sep}`) && shown !== ".." && !isAbsolute(shown));
    if (insideWorkspace) return shown ? shown.split(sep).join("/") : ".";
    return `<external-path:${sha256(absolute).slice(0, 12)}>`;
  }

  safeErrorMessage(error, toolArgs = {}) {
    let message = boundedErrorMessage(error);
    if (!this.policy.exposeAbsolutePaths) {
      for (const prefix of equivalentPathPrefixes(this.workspace, this.workspaceInput)) message = replacePathPrefix(message, prefix, ".");
      for (const prefix of equivalentPathPrefixes(this.runtimeDir)) message = replacePathPrefix(message, prefix, "<runtime>");
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) message = replacePathPrefix(message, resolve(home), "<home>");
      for (const candidate of collectToolPathCandidates(error, toolArgs, this.workspaceInput)) {
        const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.workspaceInput, candidate);
        const replacement = this.displayPath(absolute);
        for (const prefix of equivalentPathPrefixes(candidate, absolute)) message = replacePathPrefix(message, prefix, replacement);
      }
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

function createRelayConnection(runtime, { workerUrl, secret, expectedVersion, onFatal }) {
  if (!workerUrl) return null;
  return new RelayConnection({
    workerUrl,
    secret,
    logger: runtime.logger,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    expectedServer: SERVER_NAME,
    expectedVersion: String(expectedVersion || ""),
    helloMessage: () => ({
      type: "hello",
      tools: runtime.tools(),
      policy: runtime.policy,
      protocol_versions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    }),
    onMessage: (data) => handleRelayData(runtime, data),
    onDisconnect: () => runtime.terminateActiveProcesses("SIGTERM", true),
    onSuperseded: () => {
      runtime.terminateActiveProcesses("SIGKILL");
      runtime.processSessionManager.clear();
      runtime.onSuperseded?.();
    },
    onFatal: (error) => {
      runtime.terminateActiveProcesses("SIGKILL");
      runtime.processSessionManager.clear();
      onFatal?.(error);
    },
  });
}

function handleRelayData(runtime, data) {
  const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(raw) > MAX_WS_MESSAGE_BYTES) {
    runtime.handleRelayProtocolViolation("server_message_too_large");
    return;
  }
  return runtime.handleMessage(raw);
}

function normalizeRelayToolCall(message) {
  const id = typeof message.id === "string" && message.id.length <= 256 ? message.id : "";
  const tool = typeof message.tool === "string" && message.tool.length <= 128 ? message.tool : "";
  const argumentsValue = message.arguments === undefined ? {} : message.arguments;
  if (!id || !tool || !isPlainRecord(argumentsValue)) return { ok: false, id };
  return {
    ok: true,
    id,
    tool,
    arguments: argumentsValue,
    timeoutMs: clampInt(message.timeout_ms, 60_000, 1000, 610_000),
  };
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function collectToolPathCandidates(error, toolArgs, workspace) {
  const candidates = new Set();
  for (const value of [error?.path, error?.dest]) if (typeof value === "string" && value) candidates.add(value);
  const visit = (value, key = "", depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/(?:^|[_-])(?:path|cwd|workspace|root|directory|dir)(?:$|[_-])/i.test(key) && value && !value.includes("\0")) candidates.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value).slice(0, 128)) visit(child, childKey, depth + 1);
  };
  visit(toolArgs);
  candidates.delete(workspace);
  return [...candidates].sort((left, right) => right.length - left.length);
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
