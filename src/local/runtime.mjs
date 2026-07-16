import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RelayConnection } from "./relay-connection.mjs";
import { ProcessSessionManager } from "./process-sessions.mjs";
export { MAX_COMMAND_BYTES } from "./process-sessions.mjs";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS, normalizePolicy, PolicyGate, SERVER_NAME } from "./tools.mjs";
import { publicError } from "./errors.mjs";
import { ProcessTracker } from "./process-tracker.mjs";
import { CallRegistry } from "./call-registry.mjs";
import { RuntimeObservability } from "./observability.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import { boundedErrorMessage, ProcessExecutionService } from "./process-execution.mjs";
import { GitService } from "./git-service.mjs";
import { LifecycleController } from "./lifecycle.mjs";
import { MAX_WRITE_BYTES, sha256, WorkspaceFileService } from "./workspace-file-service.mjs";
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
import { clampInteger } from "./numbers.mjs";
import { isPlainRecord } from "./records.mjs";
import { AccountAccessGate, normalizeAccountRole } from "./account-access.mjs";
import { buildProjectOverview, buildRuntimeInfo } from "./runtime-reporting.mjs";
import { diagnoseRuntime as runRuntimeDiagnostics } from "./runtime-diagnostics.mjs";
import {
  resolveTaskCapabilities as resolveRuntimeTaskCapabilities,
  sessionBootstrap as buildRuntimeSessionBootstrap,
} from "./runtime-capabilities.mjs";

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
  list_files: (runtime, args, context) => runtime.listFiles(args.path || ".", clampInteger(args.max_files, 1000, 1, 10000), context),
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
  exec_command: (runtime, args, context) => runtime.execCommand(args.command, clampInteger(args.timeout_seconds, 120, 1, 600), context),
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
    this.accountAccessGate = new AccountAccessGate();
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
      accountAccessGate: this.accountAccessGate,
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
    return buildRuntimeInfo({
      workspace: this.workspace,
      displayPath: (value) => this.displayPath(value),
      policy: this.policy,
      toolNames: this.tools(),
      capabilityObserver: this.capabilityObserver,
      observability: this.observability,
      callRegistry: this.callRegistry,
      lifecycle: this.lifecycle,
      relayStatus: () => this.relay?.status?.() || null,
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
      processSessionManager: this.processSessionManager,
      managedJobManager: this.managedJobManager,
    });
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
      if (envelope.id) this.deliverRelayToolResult({
        type: "tool_result",
        id: envelope.id,
        ok: false,
        error: { code: "invalid_request", message: "invalid tool_call envelope", retryable: false },
      });
      return;
    }
    let response;
    try {
      const result = await this.executeTool(envelope.tool, envelope.arguments, {
        callId: envelope.id,
        origin: "relay",
        timeoutMs: envelope.timeoutMs,
        authorization: envelope.authorization,
      });
      response = { type: "tool_result", id: envelope.id, ok: true, result };
    } catch (error) {
      response = { type: "tool_result", id: envelope.id, ok: false, error: publicError(error) };
    }
    this.deliverRelayToolResult(response);
  }

  deliverRelayToolResult(response) {
    if (this.send(response)) return true;
    this.logger.event?.("warn", "relay.tool_result.delivery_failed", { call_id: shortCallId(response?.id) });
    this.relay?.interrupt?.("relay_transport_error");
    return false;
  }

  finishCall(callId) {
    if (!callId) return;
    this.callRegistry.finish(callId);
  }

  cancelCall(callId, reason = "cancelled") {
    return this.callRegistry.cancel(callId, reason);
  }

  handleRelayDisconnect() {
    const cancelled = this.callRegistry.cancelOrigin("relay", "remote relay disconnected");
    this.terminateActiveProcesses("SIGTERM", true);
    if (cancelled > 0) {
      this.logger.event?.("debug", "relay.calls.cancelled_on_disconnect", { cancelled_calls: cancelled });
    }
  }

  async executeTool(tool, args, context = {}) {
    this.lifecycle.assertOperational();
    return this.toolExecutor.execute(tool, args, {
      callId: context.callId,
      origin: context.origin || "local",
      timeoutMs: context.timeoutMs,
      authorization: context.authorization,
      context,
    });
  }

  async projectOverview(context = {}) {
    return buildProjectOverview({
      workspace: this.workspace,
      displayPath: (value) => this.displayPath(value),
      policy: this.policy,
      toolNames: this.tools(),
      capabilityObserver: this.capabilityObserver,
      listTopLevel: (callContext) => this.listDir(".", callContext),
      runProcess: (...args) => this.runProcess(...args),
      safeErrorMessage: (error) => this.safeErrorMessage(error),
      throwIfCancelled: (callContext) => this.throwIfCancelled(callContext),
    }, context);
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
    return runRuntimeDiagnostics({
      policy: this.policy,
      runtimeDir: this.runtimeDir,
      workspace: this.workspace,
      runProcess: (...args) => this.runProcess(...args),
      probeShell: (callContext) => this.processExecutionService.probeShell(callContext),
      managedJobManager: this.managedJobManager,
      throwIfCancelled: (callContext) => this.throwIfCancelled(callContext),
    }, context);
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
    return buildRuntimeSessionBootstrap({
      agentContextManager: this.agentContextManager,
      appAutomationManager: this.appAutomationManager,
      capabilityObserver: this.capabilityObserver,
      policy: this.policy,
    }, args, context);
  }

  async resolveTaskCapabilities(args = {}, context = {}) {
    return resolveRuntimeTaskCapabilities({
      agentContextManager: this.agentContextManager,
      appAutomationManager: this.appAutomationManager,
      capabilityObserver: this.capabilityObserver,
      policy: this.policy,
    }, args, context);
  }

  readLocalResourceBinary(name) {
    const registry = this.managedJobManager.currentResources();
    const resource = Object.hasOwn(registry, name) ? registry[name] : null;
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
    onDisconnect: () => runtime.handleRelayDisconnect(),
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
  const authorization = normalizeRelayAuthorization(message.authorization);
  if (!id || !tool || !isPlainRecord(argumentsValue) || !authorization) return { ok: false, id };
  return {
    ok: true,
    id,
    tool,
    arguments: argumentsValue,
    authorization,
    timeoutMs: clampInteger(message.timeout_ms, 60_000, 1000, 610_000),
  };
}

function normalizeRelayAuthorization(value) {
  if (!isPlainRecord(value)) return null;
  const accountId = typeof value.account_id === "string" && /^acct_[A-Za-z0-9_-]{20,96}$/.test(value.account_id) ? value.account_id : "";
  const accountVersion = Number(value.account_version);
  let role;
  try { role = normalizeAccountRole(value.role); } catch { return null; }
  if (!accountId || !Number.isInteger(accountVersion) || accountVersion < 1) return null;
  return Object.freeze({ account_id: accountId, account_version: accountVersion, role });
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
