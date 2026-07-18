import { realpathSync, rmSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isRelayReadyContext } from "./relay-connection.mjs";
import { ProcessSessionManager } from "./process-sessions.mjs";
import { MAX_CONCURRENT_TOOL_CALLS } from "./execution-limits.mjs";
export { MAX_COMMAND_BYTES } from "./process-contract.mjs";
import { normalizePolicy, PolicyGate } from "./tools.mjs";
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
import { isPlainRecord } from "./records.mjs";
import { AccountAccessGate } from "./account-access.mjs";
import { buildProjectOverview, buildRuntimeInfo } from "./runtime-reporting.mjs";
import { diagnoseRuntime as runRuntimeDiagnostics } from "./runtime-diagnostics.mjs";
import { bindRuntimeToolHandlers, runtimeToolHandlerNames as registeredRuntimeToolHandlerNames } from "./runtime-tool-handlers.mjs";
import { createRuntimeRelayConnection, normalizeRelayToolCall } from "./runtime-relay.mjs";
import { assertContainedPath, createRuntimeDir, redactRuntimeErrorMessage, stateRootFromProfileStatePath } from "./runtime-paths.mjs";
import {
  resolveTaskCapabilities as resolveRuntimeTaskCapabilities,
  sessionBootstrap as buildRuntimeSessionBootstrap,
} from "./runtime-capabilities.mjs";

const SLOW_TOOL_CALL_MS = 30_000;

export function runtimeToolHandlerNames() {
  return registeredRuntimeToolHandlerNames();
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
    this.activeRelayCalls = new Set();
    this.suppressedRelayResults = new Map();
    this.callRegistry = new CallRegistry({
      maximum: MAX_CONCURRENT_TOOL_CALLS,
      onCancel: (record) => {
        this.processSessionManager?.notifyCancellation();
        this.browserBridgeManager?.cancelCall(record.id);
        this.processTracker.terminateCall(record.id);
        this.logger.event?.("debug", "tool.call.cancel_requested", {
          call_id: shortCallId(record.id), tool: record.tool, origin: record.origin,
        }, "Tool call cancellation requested");
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
      logger: this.logger,
    });
    this.toolExecutor = new ToolExecutor({
      handlers: bindRuntimeToolHandlers(this),
      policyGate: this.policyGate,
      accountAccessGate: this.accountAccessGate,
      callRegistry: this.callRegistry,
      observability: this.observability,
      logger: this.logger,
      safeMessage: (error, args) => this.safeErrorMessage(error, args),
      slowMs: SLOW_TOOL_CALL_MS,
    });
    this.relay = createRuntimeRelayConnection(this, {
      workerUrl: remoteWorkerUrl,
      secret: remoteSecret,
      expectedVersion: expectedRelayVersion,
      onFatal,
    });
  }

  tools() { return this.policyGate.names().filter((name) => name !== "server_info"); }

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

  async handleMessage(raw, relayContext = {}) {
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
    if (message.type === "relay_probe") {
      if (isRelayReadyContext(relayContext, this.relay)) return this.handleRelayProtocolViolation("unexpected_relay_probe");
      this.handleRelayProbe(message, relayContext);
      return;
    }
    if (message.type !== "tool_call") return this.handleRelayProtocolViolation("unexpected_server_message_type");
    if (!isRelayReadyContext(relayContext, this.relay)) return this.handleRelayProtocolViolation("tool_call_before_ready");
    await this.handleRelayToolCall(message, relayContext);
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
    if (message.type === "ready_ack") {
      this.relay?.confirmReady(message);
      return true;
    }
    if (message.type === "pong") return true;
    if (message.type === "error") {
      this.relay?.handleServerError(message);
      return true;
    }
    if (message.type === "cancel_call") {
      if (typeof message.id === "string") this.cancelRelayCall(message.id, "caller_cancelled");
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

  handleRelayProbe(message, relayContext = {}) {
    const id = typeof message?.id === "string" && /^probe_[A-Za-z0-9_-]{8,240}$/.test(message.id) ? message.id : "";
    const relaySessionId = Number(relayContext.sessionId) || 0;
    if (!id || !relaySessionId) return this.handleRelayProtocolViolation("invalid_relay_probe");
    this.deliverRelayToolResult({ type: "relay_probe_result", id }, relaySessionId);
  }

  async handleRelayToolCall(message, relayContext = {}) {
    const envelope = normalizeRelayToolCall(message);
    const relaySessionId = Number(relayContext.sessionId) || 0;
    if (!envelope.ok) {
      this.logger.warn?.("Received an invalid tool request from the relay; the request was rejected.");
      this.logger.event?.("debug", "relay.tool_call.invalid", {
        has_call_id: Boolean(envelope.id),
      }, "Invalid relay tool request details");
      if (envelope.id) this.deliverRelayToolResult({
        type: "tool_result",
        id: envelope.id,
        ok: false,
        error: { code: "invalid_request", message: "invalid tool_call envelope", retryable: false },
      }, relaySessionId);
      return;
    }
    if (this.activeRelayCalls.has(envelope.id)) {
      this.handleRelayProtocolViolation("duplicate_tool_call_id");
      return;
    }
    this.activeRelayCalls.add(envelope.id);
    try {
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
      const suppressionReason = this.suppressedRelayResults.get(envelope.id) || "";
      if (suppressionReason) {
        this.logger.event?.("debug", "relay.tool_result.discarded", {
          call_id: shortCallId(envelope.id), reason: suppressionReason,
        }, "Discarded a tool result because the caller was no longer waiting");
        return;
      }
      this.deliverRelayToolResult(response, relaySessionId);
    } finally {
      this.activeRelayCalls.delete(envelope.id);
      this.suppressedRelayResults.delete(envelope.id);
    }
  }

  deliverRelayToolResult(response, relaySessionId = 0) {
    const sessionId = Number(relaySessionId) || 0;
    const outcome = this.relay?.sendForSession
      ? this.relay.sendForSession(response, sessionId)
      : (this.send(response) ? { ok: true, reason: "sent" } : { ok: false, reason: "transport_unavailable" });
    if (outcome?.ok) return true;
    const reason = String(outcome?.reason || "transport_unavailable");
    const missingSession = reason === "session_ended" && sessionId <= 0;
    this.logger.event?.(missingSession ? "error" : "debug", "relay.tool_result.discarded", {
      call_id: shortCallId(response?.id), reason, relay_session_id: sessionId,
      active_session_id: Number(this.relay?.currentSessionId?.() || 0),
    }, missingSession
      ? "Discarded a tool result because the relay session id was missing from the inbound tool_call context"
      : reason === "send_failed"
        ? "Could not send a tool result because the relay transport failed"
        : "Discarded a tool result because its relay session had ended");
    if (reason === "send_failed") this.relay?.interrupt?.("relay_transport_error");
    return false;
  }

  finishCall(callId) {
    if (!callId) return;
    this.callRegistry.finish(callId);
  }

  cancelCall(callId, reason = "cancelled") {
    return this.callRegistry.cancel(callId, reason);
  }

  cancelRelayCall(callId, suppressionReason = "caller_cancelled") {
    const id = String(callId);
    if (this.activeRelayCalls.has(id)) this.suppressedRelayResults.set(id, suppressionReason);
    return this.cancelCall(id, "remote cancellation");
  }

  handleRelayDisconnect() {
    for (const callId of this.activeRelayCalls) this.suppressedRelayResults.set(callId, "relay_disconnected");
    const cancelled = this.callRegistry.cancelOrigin("relay", "remote relay disconnected");
    this.terminateActiveProcesses("SIGTERM", true);
    if (cancelled > 0) {
      this.logger.event?.("debug", "relay.calls.cancelled_on_disconnect", { cancelled_calls: cancelled },
        "Cancelled in-flight tool calls after the relay connection ended");
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
    const message = boundedErrorMessage(error);
    if (this.policy.exposeAbsolutePaths) return message;
    return redactRuntimeErrorMessage(message, {
      error,
      toolArgs,
      workspace: this.workspace,
      workspaceInput: this.workspaceInput,
      runtimeDir: this.runtimeDir,
      home: process.env.HOME || process.env.USERPROFILE || "",
      displayPath: (value) => this.displayPath(value),
    });
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

function shortCallId(value) {
  return String(value || "").slice(0, 20);
}
