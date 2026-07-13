import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RelayConnection } from "./relay-connection.mjs";
import { MAX_COMMAND_BYTES, ProcessSessionManager } from "./process-sessions.mjs";
export { MAX_COMMAND_BYTES } from "./process-sessions.mjs";
import { allToolNames, assertCanonicalFullPolicy, isCanonicalFullPolicy, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS, normalizePolicy, POLICY_PROFILES, PolicyGate, SERVER_NAME } from "./tools.mjs";
import { publicError } from "./errors.mjs";
import { ProcessTracker } from "./process-tracker.mjs";
import { CallRegistry } from "./call-registry.mjs";
import { RuntimeObservability } from "./observability.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import { boundedErrorMessage, ProcessExecutionService } from "./process-execution.mjs";
import { GitService } from "./git-service.mjs";
import { LifecycleController } from "./lifecycle.mjs";
import { MAX_WRITE_BYTES, readBoundedFile, sha256, WorkspaceFileService } from "./workspace-file-service.mjs";
export { MAX_WRITE_BYTES, sha256 } from "./workspace-file-service.mjs";
import { classifyOperationalError } from "./log.mjs";
import { inspectResourceFile, ManagedJobManager } from "./managed-jobs.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { expandHome } from "./state.mjs";
import { AgentContextManager } from "./agent-context.mjs";
import { AppAutomationManager } from "./app-automation.mjs";
import { BrowserBridgeManager } from "./browser-bridge.mjs";
import { CapabilityObserver } from "./capability-observer.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_TOOL_CALLS = 16;
const SLOW_TOOL_CALL_MS = 30_000;

const RUNTIME_TOOL_HANDLERS = Object.freeze({
  server_info: (runtime) => runtime.runtimeInfo(),
  project_overview: (runtime, _args, context) => runtime.projectOverview(context),
  session_bootstrap: (runtime, args, context) => runtime.sessionBootstrap(args, context),
  agent_context: (runtime, args, context) => runtime.agentContextManager.agentContext(args, context),
  resolve_task_capabilities: (runtime, args, context) => runtime.resolveTaskCapabilities(args, context),
  list_local_skills: (runtime, args, context) => runtime.agentContextManager.listLocalSkills(args, context),
  load_local_skill: (runtime, args, context) => runtime.agentContextManager.loadLocalSkill(args, context),
  list_local_commands: (runtime, args, context) => runtime.agentContextManager.listLocalCommands(args, context),
  run_local_command: (runtime, args, context) => runtime.runLocalCommand(args, context),
  list_local_applications: (runtime, args, context) => runtime.appAutomationManager.listApplications(args, context),
  open_local_application: (runtime, args, context) => runtime.appAutomationManager.openApplication(args, context),
  inspect_local_application: (runtime, args, context) => runtime.appAutomationManager.inspectApplication(args, context),
  operate_local_application: (runtime, args, context) => runtime.appAutomationManager.operateApplication(args, context),
  browser_status: (runtime, _args, context) => runtime.browserBridgeManager.status(context),
  pair_browser_extension: (runtime, args, context) => runtime.browserBridgeManager.pair(args, context),
  browser_list_tabs: (runtime, args, context) => runtime.browserBridgeManager.listTabs(args, context),
  browser_manage_tabs: (runtime, args, context) => runtime.browserBridgeManager.manageTabs(args, context),
  browser_wait: (runtime, args, context) => runtime.browserBridgeManager.wait(args, context),
  browser_get_source: (runtime, args, context) => runtime.browserBridgeManager.getSource(args, context),
  browser_inspect_page: (runtime, args, context) => runtime.browserBridgeManager.inspectPage(args, context),
  browser_action: (runtime, args, context) => runtime.browserBridgeManager.act(args, context),
  browser_fill_form: (runtime, args, context) => runtime.browserBridgeManager.fillForm(args, context),
  browser_screenshot: (runtime, args, context) => runtime.browserBridgeManager.screenshot(args, context),
  browser_upload_files: (runtime, args, context) => runtime.browserBridgeManager.uploadFiles(args, context),
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
  constructor({ workerUrl = "", secret = "", expectedRelayVersion = "", workspace, policy, logger = console, onSuperseded = null, onFatal = null, jobRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "", agentHome = process.env.HOME || process.env.USERPROFILE || "", codexHome = process.env.CODEX_HOME || "", recoverJobs = true, applicationAutomation = {} }) {
    const remoteWorkerUrl = workerUrl ? String(workerUrl) : "";
    const remoteSecret = secret || "";
    this.workspaceInput = resolve(workspace || process.cwd());
    this.workspace = realpathSync.native ? realpathSync.native(this.workspaceInput) : realpathSync(this.workspaceInput);
    this.workspaceCanonicalPromise = null;
    this.policy = normalizePolicy(policy);
    this.policyGate = new PolicyGate(this.policy);
    this.logger = logger;
    this.onSuperseded = typeof onSuperseded === "function" ? onSuperseded : null;
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.processTracker = new ProcessTracker();
    this.lifecycle = new LifecycleController("local runtime");
    this.observability = new RuntimeObservability();
    this.callRegistry = new CallRegistry({
      maximum: MAX_CONCURRENT_TOOL_CALLS,
      onCancel: (record) => {
        this.processSessionManager?.notifyCancellation();
        this.browserBridgeManager?.cancelCall(record.id);
        this.processTracker.terminateCall(record.id);
        this.logger.event?.("debug", "tool.call.cancel_requested", {
          call_id: shortCallId(record.id), tool: record.tool, origin: record.origin,
        });
      },
      onFinish: (record) => this.processTracker.releaseCall(record.id),
    });
    this.mutationQueue = Promise.resolve();
    this.capabilityObserver = new CapabilityObserver();
    this.runtimeDir = createRuntimeDir();
    this.workspaceFileService = new WorkspaceFileService({
      workspace: this.workspace,
      policy: this.policy,
      policyGate: this.policyGate,
      resolveExistingPath: (value) => this.resolveExistingPath(value),
      resolveWritePath: (value) => this.resolveWritePath(value),
      displayPath: (value) => this.displayPath(value),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
      withMutationLock: (operation) => this.withMutationLock(operation),
    });
    if (typeof jobRoot !== "string" || !jobRoot.trim()) throw new Error("persistent managed-job root is required");
    this.managedJobManager = new ManagedJobManager({
      jobRoot,
      workspace: this.workspace,
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      resources,
      resourceStatePath,
      stateRoot: browserStateRoot,
      logger: this.logger,
      recover: recoverJobs,
    });
    this.processSessionManager = new ProcessSessionManager({
      workspace: this.workspace,
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
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
      home: agentHome,
      codexHome,
    });
    this.processExecutionService = new ProcessExecutionService({
      workspace: this.workspace,
      policy: this.policy,
      policyGate: this.policyGate,
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
      resolveExistingPath: (value) => this.resolveExistingPath(value),
      resolveLocalCommand: (args, context) => this.agentContextManager.resolveLocalCommand(args, context),
      displayPath: (value) => this.displayPath(value),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.gitService = new GitService({
      resolveExistingPath: (value) => this.resolveExistingPath(value),
      displayPath: (value) => this.displayPath(value),
      runProcess: (...args) => this.processExecutionService.run(...args),
      maximumBytes: MAX_WRITE_BYTES,
    });
    const runProcess = (cmd, argv, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin) => this.runProcess(cmd, argv, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin);
    const readResourceText = (name) => this.readLocalResourceText(name);
    const readResourceBinary = (name) => this.readLocalResourceBinary(name);
    this.appAutomationManager = new AppAutomationManager({
      ...applicationAutomation,
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      displayPath: (value) => this.displayPath(value),
      runProcess,
      readResourceText,
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.browserBridgeManager = new BrowserBridgeManager({
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      stateRoot: browserStateRoot,
      runProcess,
      readResourceText,
      readResourceBinary,
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.toolExecutor = new ToolExecutor({
      handlers: Object.fromEntries(Object.entries(RUNTIME_TOOL_HANDLERS).map(([name, handler]) => [
        name,
        (args, context) => handler(this, args, context),
      ])),
      policyGate: this.policyGate,
      callRegistry: this.callRegistry,
      observability: this.observability,
      logger: this.logger,
      safeMessage: (error, args) => this.safeErrorMessage(error, args),
      slowMs: SLOW_TOOL_CALL_MS,
    });
    this.relay = createRelayConnection(this, {
      workerUrl: remoteWorkerUrl,
      secret: remoteSecret,
      expectedVersion: expectedRelayVersion,
      onFatal,
    });
  }

  tools() {
    return this.policyGate.names().filter((name) => name !== "server_info");
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
        per_tool_events: "structured-debug-events",
        default_logs_include_tool_failures: false,
        tool_arguments_or_results_logged: false,
        capability_routing: this.capabilityObserver.snapshot(),
        tool_calls: this.observability.snapshot(),
        in_flight_calls: this.callRegistry.snapshot(),
      },
      runtime: {
        environment: this.policy.minimalEnv ? "isolated-minimal" : "full-parent",
        lifecycle: this.lifecycle.snapshot(),
        relay: this.relay?.status?.() || null,
        runtime_dir: this.policy.exposeAbsolutePaths ? this.runtimeDir : "<private-runtime-dir>",
        processes: this.processTracker.snapshot(),
        process_sessions: this.processSessionManager.status(),
        managed_jobs: this.managedJobManager.status(),
        local_resources: this.managedJobManager.resourceInfo(),
      },
    };
  }

  async start() {
    if (!this.relay) throw new Error("remote daemon start requires a Worker URL and daemon secret");
    if (!this.lifecycle.beginStart()) return;
    if (this.policy.profile === "full") {
      void this.browserBridgeManager.ensureStarted().catch((error) => {
        this.logger.warn?.("browser bridge did not start; browser tools remain unavailable", { error_class: classifyOperationalError(error) });
      });
    }
    try {
      await this.relay.start();
      this.lifecycle.markRunning();
    } catch (error) {
      this.lifecycle.markFailed(error);
      throw error;
    }
  }

  stop() {
    if (!this.lifecycle.beginStop()) return;
    try {
      this.relay?.stop();
      this.callRegistry.cancelAll("runtime stopped");
      this.terminateActiveProcesses("SIGKILL");
      this.processSessionManager.clear();
      this.browserBridgeManager?.stop();
      rmSync(this.runtimeDir, { recursive: true, force: true });
    } finally {
      this.lifecycle.markStopped();
    }
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
      this.logger.event?.("warn", "relay.tool_call.invalid", { has_call_id: Boolean(envelope.id) });
      if (envelope.id) this.send({ type: "tool_result", id: envelope.id, ok: false, error: { code: "invalid_request", message: "invalid tool_call envelope", retryable: false } });
      return;
    }
    try {
      const result = await this.executeTool(envelope.tool, envelope.arguments, {
        callId: envelope.id,
        origin: "relay",
        timeoutMs: envelope.timeoutMs,
      });
      this.send({ type: "tool_result", id: envelope.id, ok: true, result });
    } catch (error) {
      this.send({ type: "tool_result", id: envelope.id, ok: false, error: publicError(error) });
    }
  }

  finishCall(callId) {
    if (!callId) return;
    this.callRegistry.finish(callId);
  }

  cancelCall(callId, reason = "cancelled") {
    return this.callRegistry.cancel(callId, reason);
  }

  async executeTool(tool, args, context = {}) {
    this.lifecycle.assertOperational();
    return this.toolExecutor.execute(tool, args, {
      callId: context.callId,
      origin: context.origin || "local",
      timeoutMs: context.timeoutMs,
      context,
    });
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
      capabilityRouting: this.capabilityObserver.snapshot(),
      topLevel: top.entries || [],
    };
  }

  listRoots() { return this.workspaceFileService.listRoots(); }

  listDir(pathValue, context = {}) { return this.workspaceFileService.listDir(pathValue, context); }

  listFiles(pathValue, maxFiles, context = {}) { return this.workspaceFileService.listFiles(pathValue, maxFiles, context); }

  readFile(args, context = {}) { return this.workspaceFileService.readFile(args, context); }

  viewImage(args, context = {}) { return this.workspaceFileService.viewImage(args, context); }

  writeFile(args, context = {}) { return this.workspaceFileService.writeFile(args, context); }

  editFile(args, context = {}) { return this.workspaceFileService.editFile(args, context); }

  applyPatch(args, context = {}) { return this.workspaceFileService.applyPatch(args, context); }

  searchText(args, context = {}) { return this.workspaceFileService.searchText(args, context); }

  gitStatus(args = {}, context = {}) {
    return this.gitService.status(args, context);
  }

  gitDiff(args = {}, context = {}) {
    return this.gitService.diff(args, context);
  }

  gitLog(args = {}, context = {}) {
    return this.gitService.log(args, context);
  }

  gitShow(args = {}, context = {}) {
    return this.gitService.show(args, context);
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
      const result = await this.processExecutionService.probeShell(context)
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
    this.policyGate.assert("generate_ssh_key_resource");
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


  async sessionBootstrap(args = {}, context = {}) {
    const bootstrap = await this.agentContextManager.sessionBootstrap(args, context);
    bootstrap.local_automation = {
      applications: this.appAutomationManager.capabilities(),
      browser: this.policy.profile === "full" ? {
        existing_profile: true,
        extension_bridge: true,
        status_tool: "browser_status",
      } : null,
    };
    this.capabilityObserver.recordBootstrap(bootstrap);
    return bootstrap;
  }

  async resolveTaskCapabilities(args = {}, context = {}) {
    const result = await this.agentContextManager.resolveTaskCapabilities(args, context);
    const task = String(args.task || "");
    if (this.policy.profile === "full") {
      const applications = await this.appAutomationManager.listApplications({ query: "", max_results: 500 }, context).catch(() => ({ applications: [] }));
      const lower = task.toLowerCase();
      result.application_matches = applications.applications
        .map((application) => ({ application, score: applicationMatchScore(lower, application) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.application.name.localeCompare(right.application.name))
        .slice(0, 20)
        .map(({ application, score }) => ({ ...application, score }));
    } else {
      result.application_matches = [];
    }
    if (result.application_matches.length) {
      result.recommended_tools = [...new Set([...result.recommended_tools, "list_local_applications", "open_local_application", "inspect_local_application", "operate_local_application"])];
    }
    result.browser_backend = this.policy.profile === "full" ? { tool: "browser_status", existing_profile: true, extension_bridge: true } : null;
    result.routing_observability = "Call server_info or project_overview to verify that bootstrap and task capability resolution reached the local runtime.";
    this.capabilityObserver.recordResolution(task, result);
    return result;
  }

  readLocalResourceBinary(name) {
    const registry = this.managedJobManager.currentResources();
    const resource = registry[name];
    if (!resource) throw new Error(`unknown local resource: ${name}`);
    const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true });
    if (inspected.size > 1024 * 1024) throw new Error("local resource exceeds 1 MiB browser injection limit");
    return { buffer: readBoundedRegularFileSync(resource.path, 1024 * 1024), path: resource.path, size: inspected.size };
  }

  readLocalResourceText(name) {
    const { buffer } = this.readLocalResourceBinary(name);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`local resource is not valid UTF-8 text: ${name}`);
    }
  }

  runDirectProcess(args, context = {}) {
    return this.processExecutionService.runDirect(args, context);
  }

  runLocalCommand(args, context = {}) {
    return this.processExecutionService.runRegistered(args, context);
  }

  execCommand(command, timeoutSeconds, context = {}) {
    return this.processExecutionService.runShell(command, timeoutSeconds, context);
  }

  terminateActiveProcesses(signal = "SIGTERM", escalate = false) {
    this.processExecutionService.terminateAll(signal, escalate);
  }

  runProcess(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = 512 * 1024, context = {}, cwd = this.workspace, stdin = null) {
    return this.processExecutionService.run(cmd, args, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin);
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
        this.processExecutionService.workspace = canonical;
        this.workspaceFileService.workspace = canonical;
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
    this.callRegistry.throwIfCancelled(context);
  }

  async withMutationLock(callback) {
    const previous = this.mutationQueue;
    let release = () => {};
    this.mutationQueue = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await callback(); } finally { release(); }
  }
}

function applicationMatchScore(task, application) {
  const name = String(application.name || "").toLowerCase();
  const id = String(application.id || "").toLowerCase();
  if (!name) return 0;
  if (task.includes(name)) return 10 + Math.min(name.length, 20);
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  return words.reduce((score, word) => score + (task.includes(word) ? 2 : 0), id && task.includes(id) ? 5 : 0);
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

function createRuntimeDir() {
  const root = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-"));
  for (const name of ["home", "tmp", "cache"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
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

function clampInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}
