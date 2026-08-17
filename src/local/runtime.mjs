import { randomBytes } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isRelayReadyContext } from "./relay-connection-classification.mjs";
import { ProcessSessionManager } from "./process-sessions.mjs";
import { CONTROL_PLANE_TOOL_NAMES, MAX_CONCURRENT_TOOL_CALLS, RESERVED_CONTROL_TOOL_CALLS, executionGuardrailsSnapshot } from "./execution-limits.mjs";
export { MAX_COMMAND_BYTES } from "./process-contract.mjs";
import { normalizePolicy, PolicyGate } from "./tools.mjs";
import { BridgeError, publicError } from "./errors.mjs";
import { ProcessTracker } from "./process-tracker.mjs";
import { CallRegistry } from "./call-registry.mjs";
import { RuntimeObservability } from "./observability.mjs";
import { ToolExecutor } from "./tool-executor.mjs";
import { boundedErrorMessage, ProcessExecutionService } from "./process-execution.mjs";
import { GitService } from "./git-service.mjs";
import { FileMutationCoordinator } from "./file-mutation-coordinator.mjs";
import { createTrustedGitResolver } from "./trusted-git-executable.mjs";
import { LifecycleController } from "./lifecycle.mjs";
import { MAX_WRITE_BYTES, sha256, WorkspaceFileService } from "./workspace-file-service.mjs";
import { projectRuntimeInfo } from "./runtime-info-projection.mjs";
import { projectOverviewDetail, projectProjectOverview } from "../shared/project-overview-projection.mjs";
export { MAX_WRITE_BYTES, sha256 } from "./workspace-file-service.mjs";
import { classifyOperationalError } from "./log.mjs";
import { ManagedJobManager } from "./managed-jobs.mjs";
import { AgentContextManager } from "./agent-context.mjs";
import { AppAutomationManager } from "./app-automation.mjs";
import { projectApplicationCapabilities } from "./application-capability-projection.mjs";
import { applicationBackgroundInputConfiguration } from "./macos-background-input.mjs";
import { BrowserBridgeManager } from "./browser-bridge.mjs";
import { ComputerUseManager } from "./computer-use.mjs";
import { CapabilityObserver } from "./capability-observer.mjs";
import { isPlainRecord } from "./records.mjs";
import { AccountAccessGate } from "./account-access.mjs";
import { buildProjectOverview, buildRuntimeInfo } from "./runtime-reporting.mjs";
import { diagnoseRuntime as runRuntimeDiagnostics } from "./runtime-diagnostics.mjs";
import { bindRuntimeToolHandlers, runtimeToolHandlerNames as registeredRuntimeToolHandlerNames } from "./runtime-tool-handlers.mjs";
import { OperationAuthorizer } from "./operation-authorization.mjs";
import { SecurityAuditLog } from "./security-audit-log.mjs";
import { delegatedProcessIsolationStatus } from "./delegated-process-sandbox.mjs";
import { policyForContext } from "./authority-context.mjs";
import { createRuntimeRelayConnection, normalizeRelayToolCall } from "./runtime-relay.mjs";
import { handleRuntimeRelayControlMessage } from "./runtime-relay-control.mjs";
import { RelayCallRecovery } from "./relay-call-recovery.mjs";
import { RuntimeResourceService } from "./runtime-resource-service.mjs";
import { assertContainedPath, createRuntimeDir, redactRuntimeErrorMessage } from "./runtime-paths.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";
import { ResourceCoordinator } from "./resource-admission.mjs";
import { runRuntimeDirectProcess, runRuntimeExecCommand, runRuntimeLocalCommand } from "./runtime-process-routing.mjs";
import {
  resolveTaskCapabilities as resolveRuntimeTaskCapabilities,
  sessionBootstrap as buildRuntimeSessionBootstrap,
} from "./runtime-capabilities.mjs";

const SLOW_TOOL_CALL_MS = 30_000;

export function runtimeToolHandlerNames() {
  return registeredRuntimeToolHandlerNames();
}

export class LocalRuntime {
  constructor({ workerUrl = "", deviceIdentity = null, expectedRelayVersion = "", workspace, policy, logger = console, onSuperseded = null, onFatal = null, jobRoot = "", securityStateRoot = "", resources = {}, resourceStatePath = "", browserStateRoot = "", agentHome = process.env.HOME || process.env.USERPROFILE || "", codexHome = process.env.CODEX_HOME || "", recoverJobs = true, applicationAutomation = {}, deviceRootStatus = null, resolveGitExecutable = null, processResourceWaitMs = undefined, resourceCoordinatorRoot = "", resourceCoordinatorOptions = null }) {
    const remoteWorkerUrl = workerUrl ? String(workerUrl) : "";
    this.workspaceInput = resolve(workspace || process.cwd());
    this.workspace = realpathSync.native ? realpathSync.native(this.workspaceInput) : realpathSync(this.workspaceInput);
    this.workspaceCanonicalPromise = null;
    this.policy = normalizePolicy(policy);
    this.policyGate = new PolicyGate(this.policy);
    this.accountAccessGate = new AccountAccessGate();
    this.logger = logger;
    this.onSuperseded = typeof onSuperseded === "function" ? onSuperseded : null;
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.deviceRootStatus = deviceRootStatus && typeof deviceRootStatus === "object" ? Object.freeze({ ...deviceRootStatus }) : null;
    this.processTracker = new ProcessTracker();
    this.resourceCoordinator = new ResourceCoordinator({ ...(resourceCoordinatorOptions || {}), ...(resourceCoordinatorRoot ? { root: resourceCoordinatorRoot } : {}) });
    if (processResourceWaitMs !== undefined && (!Number.isInteger(processResourceWaitMs) || processResourceWaitMs < 0)) {
      throw new TypeError("processResourceWaitMs must be a non-negative integer when configured");
    }
    const resourceWaitMs = processResourceWaitMs === undefined ? undefined : Math.min(processResourceWaitMs, 30 * 60_000);
    this.lifecycle = new LifecycleController("local runtime");
    this.observability = new RuntimeObservability();
    this.relayInstanceId = `daemon_${randomBytes(18).toString("base64url")}`;
    this.activeRelayCalls = new Set();
    this.suppressedRelayResults = new Map();
    this.relayResumeSessionId = 0;
    this.callRegistry = new CallRegistry({
      maximum: MAX_CONCURRENT_TOOL_CALLS,
      reserved: RESERVED_CONTROL_TOOL_CALLS,
      reservedTools: CONTROL_PLANE_TOOL_NAMES,
      onCancel: (record) => {
        this.processSessionManager?.notifyCancellation();
        this.browserBridgeManager?.cancelCall(record.id, record.controller.signal.reason);
        this.processTracker.terminateCall(record.id);
        this.logger.event?.("debug", "tool.call.cancel_requested", {
          call_id: shortCallId(record.id), tool: record.tool, origin: record.origin,
        }, "Tool call cancellation requested");
      },
      onFinish: (record) => this.processTracker.releaseCall(record.id),
    });
    this.fileMutationCoordinator = new FileMutationCoordinator();
    this.capabilityObserver = new CapabilityObserver();
    this.runtimeDir = createRuntimeDir();
    this.resolveGitExecutable = createTrustedGitResolver({ resolve: resolveGitExecutable, workspace: this.workspace, stateRoot: browserStateRoot, runtimeDir: this.runtimeDir, home: agentHome });
    this.workspaceFileService = new WorkspaceFileService({
      workspace: this.workspace,
      policy: this.policy,
      policyGate: this.policyGate,
      policyForContext: (context) => this.effectivePolicy(context),
      resolveExistingPath: (value, context) => this.resolveExistingPath(value, context),
      resolveWritePath: (value, context) => this.resolveWritePath(value, context),
      displayPath: (value, context) => this.displayPath(value, context),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
      withMutationPaths: (paths, operation) => this.fileMutationCoordinator.withPaths(paths, operation),
    });
    if (typeof jobRoot !== "string" || !jobRoot.trim()) throw new Error("persistent managed-job root is required");
    this.managedJobManager = new ManagedJobManager({
      jobRoot,
      workspace: this.workspace,
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      policyForContext: (context) => this.effectivePolicy(context),
      resources,
      resourceStatePath,
      stateRoot: browserStateRoot,
      logger: this.logger,
      recover: recoverJobs,
      runnerEnvironmentOverrides: resourceCoordinatorRoot ? { AGENT_RESOURCE_COORDINATOR_ROOT: resolve(resourceCoordinatorRoot) } : {},
    });
    this.processSessionManager = new ProcessSessionManager({
      workspace: this.workspace,
      policy: this.policy,
      authorizeTool: (tool) => this.policyGate.assert(tool),
      policyForContext: (context) => this.effectivePolicy(context),
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
      resourceCoordinator: this.resourceCoordinator,
      resourceWaitMs,
      resolveCwd: async (input, context) => {
        const cwd = await this.resolveExistingPath(input, context);
        if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
        return cwd;
      },
      displayPath: (value, context) => this.displayPath(value, context),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.agentContextManager = new AgentContextManager({
      workspace: this.workspace,
      policy: this.policy,
      policyForContext: (context) => this.effectivePolicy(context),
      displayPath: (value, context) => this.displayPath(value, context),
      resolveExistingPath: (value, context) => this.resolveExistingPath(value, context),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
      home: agentHome,
      codexHome,
    });
    this.processExecutionService = new ProcessExecutionService({
      workspace: this.workspace,
      policy: this.policy,
      policyGate: this.policyGate,
      policyForContext: (context) => this.effectivePolicy(context),
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
      resourceCoordinator: this.resourceCoordinator,
      resourceWaitMs,
      resolveExistingPath: (value, context) => this.resolveExistingPath(value, context),
      resolveLocalCommand: (args, context) => this.agentContextManager.resolveLocalCommand(args, context),
      displayPath: (value, context) => this.displayPath(value, context),
      throwIfCancelled: (context) => this.throwIfCancelled(context),
      retainCompletedOutput: (value, context) => this.processSessionManager.retainCompletedOutput(value, context),
    });
    this.gitService = new GitService({
      resolveExistingPath: (value, context) => this.resolveExistingPath(value, context),
      resolveWritePath: (value, context) => this.resolveWritePath(value, context),
      displayPath: (value, context) => this.displayPath(value, context),
      runInternalProcess: (...args) => this.processExecutionService.runFixedInternal(...args),
      gitExecutable: () => this.resolveGitExecutable(),
      maximumBytes: MAX_WRITE_BYTES,
    });
    this.runtimeResourceService = new RuntimeResourceService({
      workspace: this.workspace,
      resourceStatePath: this.resourceStatePath,
      currentResources: () => this.managedJobManager.currentResources(),
      authorizeTool: (tool) => this.policyGate.assert(tool),
    });
    const runProcess = (cmd, argv, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin, options) => this.runProcess(cmd, argv, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin, options);
    const readResourceText = (name) => this.runtimeResourceService.readText(name);
    const readResourceBinary = (name) => this.runtimeResourceService.readBinary(name);
    this.appAutomationManager = createAppAutomationManager(this, applicationAutomation, runProcess, readResourceText);
    this.securityAudit = new SecurityAuditLog({ root: securityStateRoot });
    this.operationAuthorizer = new OperationAuthorizer({
      workspace: this.workspace,
      root: securityStateRoot,
      resolveExistingPath: (value, context) => this.resolveExistingPath(value, context),
      resolveWritePath: (value, context) => this.resolveWritePath(value, context),
      protectedRoots: [securityStateRoot, browserStateRoot],
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
    this.computerUseManager = new ComputerUseManager({
      authorizeTool: (tool) => this.policyGate.assert(tool),
      browserBridgeManager: this.browserBridgeManager,
      appAutomationManager: this.appAutomationManager,
      throwIfCancelled: (context) => this.throwIfCancelled(context),
    });
    this.toolExecutor = new ToolExecutor({
      handlers: bindRuntimeToolHandlers(this),
      policyGate: this.policyGate,
      accountAccessGate: this.accountAccessGate,
      operationAuthorizer: this.operationAuthorizer,
      callRegistry: this.callRegistry,
      observability: this.observability,
      securityAudit: this.securityAudit,
      logger: this.logger,
      safeMessage: (error, args, context) => this.safeErrorMessage(error, args, context),
      slowMs: SLOW_TOOL_CALL_MS,
    });
    this.relay = createRuntimeRelayConnection(this, {
      workerUrl: remoteWorkerUrl, deviceIdentity, expectedVersion: expectedRelayVersion, onFatal,
    });
    this.relayCallRecovery = new RelayCallRecovery({
      logger: this.logger,
      send: (value) => this.send(value),
      isRecoverable: () => Boolean(this.relay && !this.relay.status?.().closed),
      activeCallIds: () => this.activeRelayCalls,
      suppressCall: (callId, reason) => this.suppressedRelayResults.set(callId, reason),
      cancelOrigin: (reason) => this.callRegistry.cancelOrigin("relay", reason),
      terminate: () => this.terminateActiveProcesses("SIGTERM", true),
    });
  }

  tools() { return this.policyGate.names().filter((name) => name !== "server_info"); }

  effectiveToolNames(context = {}) {
    const policyNames = this.policyGate.names();
    const principal = context?.authority?.principal;
    if (principal?.kind !== "account") return policyNames;
    const accountNames = new Set(this.accountAccessGate.names(principal.role));
    return policyNames.filter((name) => accountNames.has(name));
  }

  serverInfo(args = {}, context = {}) { return projectRuntimeInfo(this.runtimeInfo(context), args.detail); }

  runtimeInfo(context = {}) {
    const info = buildRuntimeInfo({
      workspace: this.workspace,
      displayPath: (value) => this.displayPath(value, context),
      policy: this.effectivePolicy(context),
      toolNames: this.effectiveToolNames(context).filter((name) => name !== "server_info"),
      daemonToolNames: this.tools(),
      capabilityObserver: this.capabilityObserver,
      observability: this.observability,
      callRegistry: this.callRegistry,
      lifecycle: this.lifecycle,
      relayStatus: () => this.relay?.status?.() || null,
      runtimeDir: this.runtimeDir,
      processTracker: this.processTracker,
      processSessionManager: this.processSessionManager,
      managedJobManager: this.managedJobManager,
      securityAudit: this.securityAudit.snapshot(), deviceRootStatus: this.deviceRootStatus, context,
    });
    return {
      ...info,
      trust: {
        ...info.trust,
        daemon_session: { ephemeral: true, certificate_lifetime_seconds: 86400, reconnect_prompts: false },
        delegated_process_isolation: delegatedProcessIsolationStatus(),
        routine_operation_prompts: false,
      },
    };
  }

  async start() {
    if (!this.relay) throw new Error("remote daemon start requires a Worker URL and device identity");
    if (!this.lifecycle.beginStart()) return;
    if (this.policy.profile === "full") {
      void this.browserBridgeManager.ensureStarted().catch((error) => {
        this.logger.warn?.("browser bridge did not start; browser tools remain unavailable", { error_class: classifyOperationalError(error) });
      });
    }
    try {
      const relayReady = await this.relay.start();
      if (this.lifecycle.snapshot().state !== "starting") return;
      if (relayReady !== true) throw new BridgeError("cancelled", "runtime relay startup was cancelled", { retryable: true });
      this.lifecycle.markRunning();
    } catch (error) {
      if (this.lifecycle.snapshot().state !== "starting") return;
      this.lifecycle.markFailed(error);
      throw error;
    }
  }

  async stop() {
    if (!this.lifecycle.beginStop()) return;
    try {
      this.relay?.stop();
      this.relayCallRecovery.stop();
      await this.callRegistry.cancelAllAndWait("runtime stopped");
      await this.processTracker.drain("SIGKILL");
      await this.processSessionManager.clearAndWait();
      await this.securityAudit.close();
      this.browserBridgeManager?.stop();
      rmSync(this.runtimeDir, { recursive: true, force: true });
    } catch (error) {
      this.lifecycle.markStopFailed(error);
      throw error;
    }
    this.lifecycle.markStopped();
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
    if (await this.handleRelayControlMessage(message, relayContext)) return;
    if (message.type === "relay_probe") {
      if (isRelayReadyContext(relayContext, this.relay)) return this.handleRelayProtocolViolation("unexpected_relay_probe");
      this.handleRelayProbe(message, relayContext);
      return;
    }
    if (message.type !== "tool_call") return this.handleRelayProtocolViolation("unexpected_server_message_type");
    if (!isRelayReadyContext(relayContext, this.relay)) return this.handleRelayProtocolViolation("tool_call_before_ready");
    await this.handleRelayToolCall(message);
  }

  handleRelayControlMessage(message, relayContext = {}) {
    return handleRuntimeRelayControlMessage(this, message, relayContext);
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
    const outcome = this.relay?.sendForSession?.({ type: "relay_probe_result", id }, relaySessionId);
    if (!outcome?.ok && !["send_failed", "transport_unavailable", "session_ended"].includes(outcome?.reason)) {
      this.handleRelayProtocolViolation("relay_probe_delivery_failed");
    }
  }

  async handleRelayToolCall(message) {
    const envelope = normalizeRelayToolCall(message);
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
      });
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
      this.deliverRelayToolResult(response);
    } finally {
      this.activeRelayCalls.delete(envelope.id);
      this.suppressedRelayResults.delete(envelope.id);
    }
  }

  deliverRelayToolResult(response) {
    return this.relayCallRecovery.deliver(response);
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
    const discardedResult = this.relayCallRecovery.discard(id);
    if (this.activeRelayCalls.has(id)) this.suppressedRelayResults.set(id, suppressionReason);
    return this.cancelCall(id, "remote cancellation") || discardedResult;
  }

  reconcileRelayCalls(resumedCallIds) {
    this.relayCallRecovery.reconcile(
      resumedCallIds,
      (callId) => this.cancelRelayCall(callId, "caller_no_longer_waiting"),
    );
  }

  handleRelayDisconnect() {
    this.relayResumeSessionId = 0;
    this.relayCallRecovery.disconnected();
  }

  handleRelayReady() {
    this.relayCallRecovery.ready();
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

  async projectOverview(args = {}, context = {}) {
    const effectivePolicy = this.effectivePolicy(context);
    const overview = await buildProjectOverview({
      workspace: this.workspace,
      displayPath: (value) => this.displayPath(value, context),
      policy: effectivePolicy,
      toolNames: this.effectiveToolNames(context).filter((name) => name !== "server_info"),
      daemonPolicy: this.policy,
      daemonToolNames: this.tools(),
      capabilityObserver: this.capabilityObserver,
      listTopLevel: (callContext) => this.listDir(".", callContext),
      resolveGitRoot: async (callContext) => (await this.gitService.context(".", callContext)).root || "",
      safeErrorMessage: (error) => this.safeErrorMessage(error, {}, context),
      throwIfCancelled: (callContext) => this.throwIfCancelled(callContext),
    }, context);
    return projectProjectOverview(overview, projectOverviewDetail(args));
  }

  listRoots(context = {}) { return this.workspaceFileService.listRoots(context); }

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

  gitCommit(args = {}, context = {}) {
    return this.gitService.commit(args, context);
  }

  async diagnoseRuntime(context = {}) {
    return runRuntimeDiagnostics({
      policy: this.policy,
      runtimeDir: this.runtimeDir,
      workspace: this.workspace,
      runFixedInternal: (...args) => this.processExecutionService.runFixedInternal(...args),
      probeShell: (callContext, timeoutMs) => this.processExecutionService.probeShell(callContext, timeoutMs),
      managedJobManager: this.managedJobManager,
      resourceCoordinatorSnapshot: () => this.resourceCoordinator.snapshot({ cwd: this.workspace }),
      relayStatus: () => this.relay?.status?.() || null,
      controlPlaneState: {
        lifecycle: this.lifecycle.snapshot(),
        inFlightCalls: this.callRegistry.snapshot(),
        processes: this.processTracker.snapshot(),
        executionGuardrails: executionGuardrailsSnapshot(),
        securityAudit: this.securityAudit.snapshot(),
      },
      throwIfCancelled: (callContext) => this.throwIfCancelled(callContext),
    }, context);
  }

  async generateSshKeyResource(args = {}, context = {}) {
    this.throwIfCancelled(context);
    return this.runtimeResourceService.generateSshKey(args);
  }

  async sessionBootstrap(args = {}, context = {}) {
    return buildRuntimeSessionBootstrap({
      agentContextManager: this.agentContextManager,
      appAutomationManager: this.appAutomationManager,
      capabilityObserver: this.capabilityObserver,
      policy: this.effectivePolicy(context),
      availableTools: this.effectiveToolNames(context),
    }, args, context);
  }

  async resolveTaskCapabilities(args = {}, context = {}) {
    return resolveRuntimeTaskCapabilities({
      agentContextManager: this.agentContextManager,
      appAutomationManager: this.appAutomationManager,
      capabilityObserver: this.capabilityObserver,
      policy: this.effectivePolicy(context),
      availableTools: this.effectiveToolNames(context),
    }, args, context);
  }

  runDirectProcess(args, context = {}) { return runRuntimeDirectProcess(this, args, context); }

  runLocalCommand(args, context = {}) { return runRuntimeLocalCommand(this, args, context); }

  execCommand(input, timeoutOrContext = {}, maybeContext = {}) { return runRuntimeExecCommand(this, input, timeoutOrContext, maybeContext); }

  terminateActiveProcesses(signal = "SIGTERM", escalate = false) {
    this.processExecutionService.terminateAll(signal, escalate);
  }

  async applyAuthorityRevocation(revocation) {
    let calls = 0; let sessions = 0; let jobs = 0;
    const failures = [];
    let sessionRevocation = null;
    try { calls = this.callRegistry.cancelAuthority(revocation); } catch (error) { failures.push(error); }
    try { sessionRevocation = Promise.resolve(this.processSessionManager.revokeAuthority(revocation)); }
    catch (error) { failures.push(error); }
    try { jobs = this.managedJobManager.revokeAuthority(revocation); } catch (error) { failures.push(error); }
    if (sessionRevocation) {
      try { sessions = await sessionRevocation; } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      throw new BridgeError("unavailable", "local authority revocation was incomplete; retained revocation must be retried", {
        cause: new AggregateError(failures, "local authority revocation failures"), retryable: true,
      });
    }
    this.logger.event?.("debug", "authority.revocation.applied", {
      calls_cancelled: calls, process_sessions_revoked: sessions, managed_jobs_cancelled: jobs,
    }, "Revoked authority removed local execution ownership");
    return { calls_cancelled: calls, process_sessions_revoked: sessions, managed_jobs_cancelled: jobs };
  }

  runProcess(cmd, args, timeoutMs, allowFailure = false, maxOutputBytes = 512 * 1024, context = {}, cwd = this.workspace, stdin = null, options = {}) {
    return this.processExecutionService.run(cmd, args, timeoutMs, allowFailure, maxOutputBytes, context, cwd, stdin, options);
  }

  effectivePolicy(context = {}) {
    return policyForContext(context, this.policy);
  }

  resolvePath(inputPath = ".") {
    const raw = String(inputPath || ".");
    if (raw.includes("\0")) throw new BridgeError("invalid_request", "path contains a NUL byte", { details: { reason: "nul_byte" } });
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

  async resolveExistingPath(inputPath = ".", context = {}) {
    const candidate = this.resolvePath(inputPath);
    const [workspace, canonical] = await Promise.all([this.canonicalWorkspace(), realpath(candidate)]);
    if (!this.effectivePolicy(context).unrestrictedPaths) assertContainedPath(workspace, canonical);
    return canonical;
  }

  async resolveWritePath(inputPath = ".", context = {}) {
    const candidate = this.resolvePath(inputPath);
    const candidateInfo = await pathEntryIfExists(candidate);
    if (candidateInfo?.isSymbolicLink()) throw new BridgeError("conflict", "refusing to overwrite a symbolic link", { details: { reason: "symbolic_link" } });
    let ancestor = candidate;
    while (!(await pathEntryIfExists(ancestor))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const [workspace, canonicalAncestor] = await Promise.all([this.canonicalWorkspace(), realpath(ancestor)]);
    if (!this.effectivePolicy(context).unrestrictedPaths) assertContainedPath(workspace, canonicalAncestor);
    const suffix = relative(ancestor, candidate);
    return suffix ? resolve(canonicalAncestor, suffix) : canonicalAncestor;
  }

  displayPath(fullPath, context = {}) {
    const absolute = resolve(fullPath);
    if (this.effectivePolicy(context).exposeAbsolutePaths) return absolute;
    const shown = relative(this.workspace, absolute);
    const insideWorkspace = shown === "" || (!shown.startsWith(`..${sep}`) && shown !== ".." && !isAbsolute(shown));
    if (insideWorkspace) return shown ? shown.split(sep).join("/") : ".";
    return `<external-path:${sha256(absolute).slice(0, 12)}>`;
  }

  safeErrorMessage(error, toolArgs = {}, context = {}) {
    const message = boundedErrorMessage(error);
    if (this.effectivePolicy(context).exposeAbsolutePaths) return message;
    return redactRuntimeErrorMessage(message, {
      error,
      toolArgs,
      workspace: this.workspace,
      workspaceInput: this.workspaceInput,
      runtimeDir: this.runtimeDir,
      home: process.env.HOME || process.env.USERPROFILE || "",
      displayPath: (value) => this.displayPath(value, context),
    });
  }

  throwIfCancelled(context = {}) {
    this.callRegistry.throwIfCancelled(context);
  }
}

function createAppAutomationManager(runtime, applicationAutomation, runProcess, readResourceText) {
  const { backgroundVisualBackend, backgroundInputService } = applicationBackgroundInputConfiguration(
    applicationAutomation, runProcess, runtime.runtimeDir,
  );
  return new AppAutomationManager({
    ...applicationAutomation,
    backgroundVisualBackend,
    backgroundInputService,
    policy: runtime.policy,
    authorizeTool: (tool) => runtime.policyGate.assert(tool),
    displayPath: (value, context) => runtime.displayPath(value, context),
    projectCapabilities: (capabilities, context) => projectRuntimeApplicationCapabilities(runtime, capabilities, context),
    runProcess,
    readResourceText,
    throwIfCancelled: (context) => runtime.throwIfCancelled(context),
  });
}

function projectRuntimeApplicationCapabilities(runtime, capabilities, context) { const available = new Set(runtime.effectiveToolNames(context)); return projectApplicationCapabilities(capabilities, (tool) => available.has(tool)); }

function shortCallId(value) {
  return String(value || "").slice(0, 20);
}
