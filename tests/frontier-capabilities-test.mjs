import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { BrowserOperationService } from "../src/local/automation/browser-operation-service.mjs";
import { projectPostObservation } from "../src/local/automation/computer-use-observation.mjs";
import { appStub, browserSnapshot, browserStub, managerWith, PNG_A_BASE64 } from "./fixtures/computer-use/common.mjs";
import { parseArgs, validateCommandOptions, validatePositionals } from "../src/local/cli/cli-activate.mjs";
import { pairCommand, verifyCommand } from "../src/local/cli/cli-admin.mjs";
import { classifyOperation, classifyReversibility, loadPrivacyDenylistCached } from "../src/local/core/operation-risk.mjs";
import { resolveTrustedGitExecutable } from "../src/local/core/trusted-executable.mjs";
import { RuntimeObservability } from "../src/local/runtime/observability.mjs";
import { StuckLoopDetector, ToolExecutor } from "../src/local/runtime/tool-executor.mjs";
import { buildRuntimeInfo } from "../src/local/runtime/runtime-services.mjs";
import { projectRuntimeInfo } from "../src/local/runtime/runtime-projections.mjs";
import { MCP_2025_PROTOCOL_VERSION, McpController } from "../src/worker/mcp/controller.ts";
import { staleSchemaGuidanceResult } from "../src/worker/mcp/stale-schema.ts";
import { dispatchWorkerToolCall, inspectWorkerToolCall } from "../src/worker/mcp/tool-call-dispatch.ts";
import { jobMonitorRenderTool, serverInfoTool, workspaceTools } from "../src/worker/mcp/tool-catalog.ts";
import { buildServerInfoResult, MCP_SERVER_CAPABILITIES } from "../src/worker/room/server-info.ts";
import { MCP_PROTOCOL_VERSION, serverImplementation } from "../src/shared/mcp-protocol.mjs";
import { terminateManagedJobActiveChild } from "../src/local/jobs/execution.mjs";
import { validatePlan } from "../src/local/jobs/plan.mjs";
import { createManagedJobTestManager, managedJobTestRunnerForCoordinatorRoot, waitForJob, waitForPidExit } from "./fixtures/managed-jobs/common.mjs";
import serverMetadata from "../src/shared/server-metadata.json" with { type: "json" };

const execFileAsync = promisify(execFile);

function createNetworkVmContext() {
  const listeners = new Set();
  const detachListeners = new Set();
  const tabRemovedListeners = new Set();
  const buffered = { sent: [] };
  const sessionSource = readFileSync(new URL("../browser-extension/devtools-session.js", import.meta.url), "utf8");
  const obsSource = readFileSync(new URL("../browser-extension/devtools-observation.js", import.meta.url), "utf8");
  const context = {
    chrome: {
      tabs: {
        async query() { return [{ id: 7, active: true }]; },
        onRemoved: {
          addListener(fn) { tabRemovedListeners.add(fn); },
          removeListener(fn) { tabRemovedListeners.delete(fn); },
        },
      },
      debugger: {
        async attach() {},
        async detach() {},
        async sendCommand(_target, method) {
          buffered.sent.push(method);
          return {};
        },
        onEvent: {
          addListener(fn) { listeners.add(fn); },
          removeListener(fn) { listeners.delete(fn); },
        },
        onDetach: {
          addListener(fn) { detachListeners.add(fn); },
          removeListener(fn) { detachListeners.delete(fn); },
        },
      },
    },
    emitNetworkEvent(tabId, method, params) {
      for (const listener of listeners) listener({ tabId }, method, params);
    },
    emitTabRemoved(tabId) {
      for (const listener of tabRemovedListeners) listener(tabId);
    },
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    RegExp,
  };
  vm.runInNewContext(sessionSource, context);
  vm.runInNewContext(obsSource, context);
  return { context, sessionSource, sent: buffered.sent };
}

test("DevTools session timeout is raised to 10s and networkLog buffers, caps, filters, and redacts secrets", async () => {
  const { context, sessionSource, sent } = createNetworkVmContext();
  assert.match(sessionSource, /COMMAND_TIMEOUT_MS\s*=\s*10_000/);

  const originalSetTimeout = context.setTimeout;
  const obs = context.__machineBridgeDevtoolsObservation;
  const fixtureCredUrl = ["https://", "user", ":", "topsecret", "@", "api.example.test", "/v1/items?token=tok123&page=2&api_key=k99"].join("");
  context.setTimeout = (fn, ms) => {
    if (ms === 5) {
      context.emitNetworkEvent(7, "Network.requestWillBeSent", {
        requestId: "req-1",
        type: "Fetch",
        request: {
          url: fixtureCredUrl,
          method: "GET",
          headers: {
            Authorization: "Bearer supersecret",
            Cookie: "sid=abc",
            "X-Api-Key": "key-xyz",
            "X-Safe-Trace": "trace-42",
          },
        },
      });
      context.emitNetworkEvent(7, "Network.responseReceived", {
        requestId: "req-1",
        type: "Fetch",
        response: {
          url: "https://api.example.test/v1/items?token=tok123&page=2&api_key=k99",
          status: 503,
          mimeType: "application/json",
          headers: {
            "Set-Cookie": "sid=newcookie; HttpOnly",
            "Content-Type": "application/json",
          },
        },
      });
      context.emitNetworkEvent(7, "Network.loadingFinished", { requestId: "req-1", encodedDataLength: 512 });
    }
    return originalSetTimeout(fn, ms === 5 ? 0 : ms);
  };

  const first = await obs.networkLog({ tabId: 7, waitMs: 5, limit: 10 }, {});
  assert.equal(sent.at(-1), "Network.enable");
  assert.equal(first.returned, 1);
  assert.equal(first.entries[0].status, 503);
  assert.equal(first.entries[0].request_headers.Authorization, "[REDACTED]");
  assert.equal(first.entries[0].request_headers.Cookie, "[REDACTED]");
  assert.equal(first.entries[0].request_headers["X-Api-Key"], "[REDACTED]");
  assert.equal(first.entries[0].request_headers["X-Safe-Trace"], "trace-42");
  assert.equal(first.entries[0].response_headers["Set-Cookie"], "[REDACTED]");
  assert.doesNotMatch(first.entries[0].url, /tok123|k99|topsecret/);
  assert.match(first.entries[0].url, /page=2/);

  context.setTimeout = (fn, ms) => {
    if (ms === 5) {
      for (let i = 0; i < 230; i += 1) {
        context.emitNetworkEvent(7, "Network.requestWillBeSent", {
          requestId: `burst-${i}`,
          type: "XHR",
          request: { url: `https://api.example.test/burst/${i}`, method: "POST", headers: {} },
        });
        context.emitNetworkEvent(7, "Network.responseReceived", {
          requestId: `burst-${i}`,
          type: "XHR",
          response: { url: `https://api.example.test/burst/${i}`, status: i % 2 === 0 ? 200 : 404, mimeType: "text/plain", headers: {} },
        });
      }
    }
    return originalSetTimeout(fn, ms === 5 ? 0 : ms);
  };

  const capped = await obs.networkLog({ tabId: 7, waitMs: 5, limit: 50, statusMin: 400, urlPrefix: "https://api.example.test/burst/" }, {});
  assert.equal(capped.total_buffered, 200);
  assert.equal(capped.truncated, true);
  assert.equal(capped.returned, 50);
  assert.equal(capped.entries.every((entry) => entry.status >= 400), true);

  const cleared = await obs.networkLog({ tabId: 7, clear: true, waitMs: 0 }, {});
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.total_buffered, 0);
  assert.equal(cleared.returned, 0);
});

test("BrowserOperationService tracks tab_owner and routes browser_network_log", async () => {
  const authorized = [];
  const calls = [];
  let createdTabs = [];
  const service = new BrowserOperationService({
    authorizeTool(name) { authorized.push(name); },
    async ensureStarted() {},
    async request(method, params, timeoutSeconds) {
      calls.push({ method, params, timeoutSeconds });
      if (method === "manage_tabs" && params.action === "new") {
        const created = { id: 88, window_id: 1, active: true, url: params.url || "about:blank", title: "" };
        createdTabs.push(created);
        return created;
      }
      if (method === "list_tabs") return { tabs: [...createdTabs, { id: 12, window_id: 1, active: false, url: "https://other.test" }] };
      if (method === "manage_tabs" && params.action === "close") {
        createdTabs = createdTabs.filter((tab) => tab.id !== params.tabId);
        return { closed: true, id: params.tabId };
      }
      if (method === "network_log") return { tab_id: params.tabId, entries: [], total_buffered: 0, returned: 0, truncated: false, cleared: params.clear };
      return { ok: true };
    },
  });

  const ownerCtx = { authority: { principal: { kind: "account", accountId: "acct-alpha" } } };
  const otherCtx = { authority: { principal: { kind: "account", accountId: "acct-beta" } } };

  const created = await service.manageTabs({ action: "new", url: "https://example.test" }, ownerCtx);
  assert.equal(created.tab_owner, "acct-alpha");
  assert.equal(created.owned_by_caller, true);

  const ownerList = await service.listTabs({}, ownerCtx);
  const ownedTab = ownerList.tabs.find((tab) => tab.id === 88);
  const unownedTab = ownerList.tabs.find((tab) => tab.id === 12);
  assert.equal(ownedTab.tab_owner, "acct-alpha");
  assert.equal(ownedTab.owned_by_caller, true);
  assert.equal(unownedTab.tab_owner, null);
  assert.equal(unownedTab.owned_by_caller, null);

  const otherList = await service.listTabs({}, otherCtx);
  assert.equal(otherList.tabs.find((tab) => tab.id === 88).owned_by_caller, false);

  await service.manageTabs({ action: "close", tab_id: 88 }, ownerCtx);
  const net = await service.networkLog({ tab_id: 12, limit: 25, status_min: 400, url_prefix: "https://api.test" }, ownerCtx);
  assert.equal(net.tab_id, 12);
  assert.equal(calls.at(-1).method, "network_log");
  assert.equal(calls.at(-1).params.statusMin, 400);
  assert.equal(new Set(authorized).has("browser_network_log"), true);
});

test("computer_observe reports unlabeled_interactive_count and include_marks on browser and application surfaces", async () => {
  const mixedSnap = browserSnapshot("https://example.test/form", "e1");
  mixedSnap.frames[0].frame_id = 0;
  mixedSnap.frames[0].elements = [
    { ref: "e1", tag: "button", role: "button", name: "", visible: true, enabled: true, bounding_box: { x: 10, y: 10, width: 40, height: 24 } },
    { ref: "e2", tag: "input", role: "textbox", name: "", placeholder: "   ", visible: true, enabled: true, bounding_box: { x: 60, y: 10, width: 120, height: 24 } },
    { ref: "e3", tag: "button", role: "button", name: "Submit", visible: true, enabled: true, bounding_box: { x: 10, y: 50, width: 80, height: 24 } },
    { ref: "e4", tag: "div", role: "generic", name: "", visible: true, enabled: true, bounding_box: { x: 0, y: 0, width: 300, height: 200 } },
  ];

  const appInspect = {
    application: "Example",
    process_name: "Example",
    frontmost: true,
    truncated: false,
    menus_included: false,
    elements: [
      { ref: "a0", role: "AXButton", name: "Apply", enabled: true, screen_box: { x: 12, y: 18, width: 70, height: 26 } },
    ],
  };

  const manager = managerWith({
    browser: browserStub({ inspectQueue: [mixedSnap] }),
    applications: appStub({
      inspectQueue: [appInspect],
      screenshotResult: {
        window: { id: 9, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window" },
      },
    }),
  });

  const browserRes = await manager.observe({ surface: "browser", include_screenshot: false, include_marks: true });
  const browserObs = browserRes.$mcp ? browserRes.$mcp.structuredContent : browserRes;
  assert.equal(browserObs.semantic.unlabeled_interactive_count, 2);
  assert.equal(browserObs.capture.marks_included, true);
  assert.equal(Array.isArray(browserObs.set_of_marks), true);
  assert.match(browserObs.set_of_marks_svg, /<svg /);
  const compactBrowser = projectPostObservation(browserObs, "summary");
  assert.equal(compactBrowser.semantic.unlabeled_interactive_count, 2);

  const appRes = await manager.observe({ surface: "application", application: "Example", include_screenshot: true, include_marks: true });
  const appObs = appRes.$mcp ? appRes.$mcp.structuredContent : appRes;
  assert.equal(appObs.capture.marks_included, true);
  assert.equal(appObs.set_of_marks.length, 1);
  assert.match(appObs.set_of_marks_svg, /<svg /);
});

test("CLI verify and pair commands validate arguments, emit structured JSON, and hide secrets", async () => {
  const [cmdVerify, restVerify] = ["verify", ["--json"]];
  const parsedVerify = parseArgs(restVerify);
  validateCommandOptions(cmdVerify, parsedVerify);
  validatePositionals(cmdVerify, parsedVerify);

  const [cmdPair, restPair] = ["pair", ["--ttl", "180", "--role", "reviewer", "--json"]];
  const parsedPair = parseArgs(restPair);
  validateCommandOptions(cmdPair, parsedPair);
  validatePositionals(cmdPair, parsedPair);

  const tempState = mkdtempSync(join(tmpdir(), "mbm-cli-verify-"));
  try {
    const verifyReport = await verifyCommand({ stateDir: tempState, json: false });
    assert.equal(verifyReport.ok, true);
    assert.equal(verifyReport.checks.node.ok, true);
    assert.equal(verifyReport.checks.tool_catalog.ok, true);
    assert.equal(verifyReport.checks.browser_extension.ok, true);

    const ticket = await pairCommand({ stateDir: tempState, ttl: "180", role: "reviewer", json: false });
    assert.match(ticket.ticket_id, /^pair_[A-Za-z0-9_-]{24}$/);
    assert.equal(ticket.role, "reviewer");
    assert.equal(ticket.ttl_seconds, 180);
    assert.equal(ticket.secrets_exposed, false);

    await assert.rejects(() => pairCommand({ ttl: "10" }), /60 and 3600/);
    await assert.rejects(() => pairCommand({ role: "superuser" }), /reviewer, editor, operator, owner/);

    const binPath = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
    const { stdout: pairStdout } = await execFileAsync(process.execPath, [binPath, "pair", "--state-dir", tempState, "--ttl", "120", "--role", "editor", "--json"]);
    const cliTicket = JSON.parse(pairStdout);
    assert.equal(cliTicket.role, "editor");
    assert.equal(cliTicket.ttl_seconds, 120);

    const { stdout: verifyStdout } = await execFileAsync(process.execPath, [binPath, "verify", "--state-dir", tempState, "--json"]);
    const cliVerify = JSON.parse(verifyStdout);
    assert.equal(cliVerify.ok, true);
  } finally {
    rmSync(tempState, { recursive: true, force: true });
  }
});

test("classifyReversibility, classifyOperation.reversibility, and loadPrivacyDenylistCached enforce invariants", async () => {
  assert.equal(classifyReversibility("read_file", { path: "README.md" }), "reversible");
  assert.equal(classifyReversibility("write_file", { path: "README.md" }), "partially_reversible");
  assert.equal(classifyReversibility("exec_command", { command: "rm -rf build" }), "irreversible");
  assert.equal(classifyReversibility("browser_action", { action: "scroll_into_view" }), "partially_reversible");
  assert.equal(classifyReversibility("browser_action", { action: "scroll" }), "irreversible");
  assert.equal(classifyReversibility("start_job", { steps: [] }), "irreversible");
  assert.equal(classifyReversibility("browser_action", { action: "click" }), "irreversible");

  const tempDir = mkdtempSync(join(tmpdir(), "mbm-risk-cache-"));
  const workspaceDir = join(tempDir, "ws");
  const outsidePath = join(tempDir, "outside-repo");
  mkdirSync(workspaceDir, { recursive: true });
  try {
    const commitDecision = await classifyOperation("git_commit", { path: outsidePath, message: "test" }, {
      workspace: workspaceDir,
      resolveWritePath: async (targetPath) => join(tempDir, "outside-repo", String(targetPath === outsidePath ? "" : targetPath)),
    });
    assert.equal(commitDecision?.reversibility, "partially_reversible");
    const execDecision = await classifyOperation("exec_command", { command: "echo hi" }, { workspace: workspaceDir });
    assert.equal(execDecision?.reversibility, "irreversible");

    const denylistPath = join(tempDir, ".privacy-denylist");
    assert.throws(() => loadPrivacyDenylistCached(denylistPath), /does not exist/);
    assert.deepEqual(loadPrivacyDenylistCached(denylistPath, { allowMissing: true }), []);

    writeFileSync(denylistPath, "# comment\nSecretTokenOne\n", "utf8");
    const firstRead = loadPrivacyDenylistCached(denylistPath);
    assert.deepEqual(firstRead, ["secrettokenone"]);
    const cachedRead = loadPrivacyDenylistCached(denylistPath);
    assert.deepEqual(cachedRead, ["secrettokenone"]);

    writeFileSync(denylistPath, "UpdatedMarkerTwo\nlongersecretthree\n", "utf8");
    const refreshed = loadPrivacyDenylistCached(denylistPath);
    assert.deepEqual(refreshed, ["updatedmarkertwo", "longersecretthree"]);

    if (process.platform !== "win32") {
      const unreadable = join(tempDir, "unreadable-denylist");
      writeFileSync(unreadable, "secret\n", "utf8");
      chmodSync(unreadable, 0o000);
      try {
        if (process.getuid?.() !== 0) {
          assert.throws(() => loadPrivacyDenylistCached(unreadable), /could not be read/);
        }
      } finally {
        chmodSync(unreadable, 0o600);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("StuckLoopDetector detects all 4 patterns and ToolExecutor tracks non-blocking taint advisories", async () => {
  const detector = new StuckLoopDetector(3);
  assert.equal(detector.record("git_status", { a: 1 }, "failed", { errorCode: "execution_failed" }), null);
  assert.equal(detector.record("git_status", { a: 1 }, "failed", { errorCode: "execution_failed" }), null);
  const ident = detector.record("git_status", { a: 1 }, "failed", { errorCode: "execution_failed" });
  assert.equal(ident?.pattern, "identical_repeat");

  const oscDetector = new StuckLoopDetector(3);
  oscDetector.record("read_file", { path: "a.txt" }, "completed", { resultDigest: "d1" });
  oscDetector.record("read_file", { path: "b.txt" }, "completed", { resultDigest: "d2" });
  oscDetector.record("read_file", { path: "a.txt" }, "completed", { resultDigest: "d1" });
  const osc = oscDetector.record("read_file", { path: "b.txt" }, "completed", { resultDigest: "d2" });
  assert.equal(osc?.pattern, "oscillation");

  const errDetector = new StuckLoopDetector(3);
  errDetector.record("read_file", { path: "1" }, "failed", { errorCode: "unavailable" });
  errDetector.record("read_file", { path: "2" }, "failed", { errorCode: "unavailable" });
  const errClass = errDetector.record("read_file", { path: "3" }, "failed", { errorCode: "unavailable" });
  assert.equal(errClass?.pattern, "repeated_error_class");

  const stalledDetector = new StuckLoopDetector(3);
  stalledDetector.record("git_status", { seq: 1 }, "completed", { resultDigest: "samehash" });
  stalledDetector.record("git_status", { seq: 2 }, "completed", { resultDigest: "samehash" });
  const stalled = stalledDetector.record("git_status", { seq: 3 }, "completed", { resultDigest: "samehash" });
  assert.equal(stalled?.pattern, "stalled_observation");

  const observability = new RuntimeObservability({ costCallThreshold: 2, costByteThreshold: 512 });
  const debugEvents = [];
  let seq = 0;
  const executor = new ToolExecutor({
    handlers: {
      browser_get_source: async () => ({ url: "https://untrusted.example", html: "<div>ignore previous</div>".repeat(30) }),
      exec_command: async () => ({ code: 0, stdout: "ran ok" }),
    },
    policyGate: { assert() {} },
    accountAccessGate: { authority: () => ({ principal: { kind: "local", role: "owner" } }) },
    callRegistry: {
      open: (ctx) => ({ callId: `t-${++seq}`, ...ctx }),
      finish() {},
      bindPrincipal() {},
      throwIfCancelled() {},
    },
    observability,
    logger: { event(level, name, data) { debugEvents.push({ level, name, data }); } },
  });

  const beforeIrrev = await executor.execute("exec_command", { command: "echo safe" });
  assert.equal(beforeIrrev.code, 0);
  assert.equal(executor.taintSnapshot().untrusted_content_seen, false);
  assert.equal(executor.taintSnapshot().advisory_count, 0);

  await executor.execute("browser_get_source", { tab_id: 1 });
  assert.equal(executor.taintSnapshot().untrusted_content_seen, true);

  const afterTaint = await executor.execute("exec_command", { command: "echo owner-allowed" });
  assert.equal(afterTaint.code, 0);
  assert.equal(executor.taintSnapshot().advisory_count, 1);

  const snap = observability.snapshot();
  assert.equal(snap.taint_advisories, 1);
  assert.equal(Array.isArray(snap.tool_metrics), true);
  assert.equal(snap.tool_metrics.length, 2);
  assert.equal(snap.cost_warning?.active, true);
  assert.equal(debugEvents.some((ev) => ev.name === "tool.call.taint_advisory"), true);
});

test("server_info exposes schema_drift and authority_delta in local and Worker projections", () => {
  const obs = new RuntimeObservability();
  const baseArgs = {
    workspace: "/tmp/ws",
    displayPath: (p) => p,
    policy: { profile: "full", origin: "explicit", allowWrite: true, execMode: "shell", minimalEnv: false, unrestrictedPaths: true, exposeAbsolutePaths: true },
    toolNames: ["read_file", "git_status"],
    daemonToolNames: ["read_file", "git_status", "write_file", "exec_command"],
    capabilityObserver: { snapshot: () => ({}) },
    observability: obs,
    callRegistry: { snapshot: () => ({ active: 0, calls: [] }) },
    lifecycle: { snapshot: () => ({ phase: "ready" }) },
    relayStatus: () => null,
    runtimeDir: "/tmp/rt",
    processTracker: { snapshot: () => ({}) },
    processSessionManager: { status: () => ({}) },
    managedJobManager: { status: () => ({}), resourceInfo: () => ({}) },
  };
  const baseInfo = buildRuntimeInfo({
    ...baseArgs,
    clientToolSchemaGeneration: Number(serverMetadata.toolSchemaGeneration) - 1,
  });

  assert.equal(baseInfo.schema_drift.drifted, true);
  assert.equal(baseInfo.schema_drift.server_generation, Number(serverMetadata.toolSchemaGeneration));
  assert.equal(baseInfo.authority_delta.omitted_count, 2);
  assert.deepEqual(baseInfo.authority_delta.omitted_sample, ["write_file", "exec_command"]);

  const nonOwnerInfo = buildRuntimeInfo({
    ...baseArgs,
    context: { authority: { origin: "relay", principal: { kind: "account", role: "reviewer" } } },
  });
  assert.equal(nonOwnerInfo.authority_delta.omitted_sample_hidden_by_authority, true);
  assert.equal(nonOwnerInfo.authority_delta.omitted_sample, undefined);
  assert.equal(nonOwnerInfo.schema_drift, undefined);

  const summary = projectRuntimeInfo(baseInfo, "summary");
  assert.equal(summary.schema_drift.drifted, true);
  assert.equal(summary.authority_delta.omitted_count, 2);

  const registryStub = {
    probingSockets: () => [],
    candidateSockets: () => [],
    readyRoleSockets: () => [],
    httpReadyChannels: () => [],
    httpCandidates: () => [],
  };
  const workerBase = {
    serverName: serverMetadata.name,
    serverVersion: "3.0.0-beta.223",
    base: "https://example.workers.dev",
    oauth: {},
    daemon: { connected: true, count: 1, tool_count: 4, tools: ["read_file", "git_status", "write_file", "exec_command"] },
    effectiveTools: ["read_file"],
    advertisedTools: ["read_file"],
    pendingSnapshot: {},
    toolListSubscription: {},
    daemonRegistry: registryStub,
    observability: { snapshot: () => ({}) },
  };
  const reviewerInfo = buildServerInfoResult({
    ...workerBase,
    authorization: { account: { role: "reviewer" }, account_role_is_owner: false, summary: {} },
    clientToolSchemaGeneration: Number(serverMetadata.toolSchemaGeneration),
  }, "summary");

  assert.equal(reviewerInfo.schema_drift.drifted, false);
  assert.equal(reviewerInfo.authority_delta.omitted_count, 3);
  assert.equal(reviewerInfo.authority_delta.omitted_sample, undefined);
  assert.equal(reviewerInfo.authority_delta.omitted_sample_hidden_by_authority, true);

  const fullOwnerInfo = buildServerInfoResult({
    ...workerBase,
    effectiveTools: ["read_file", "git_status"],
    authorization: { account: { role: "owner" }, account_role_is_owner: true, summary: {} },
    clientToolSchemaGeneration: Number(serverMetadata.toolSchemaGeneration) - 1,
  }, "full");

  assert.equal(fullOwnerInfo.schema_drift.drifted, true);
  assert.equal(new Set(fullOwnerInfo.authority_delta.omitted_sample).has("write_file"), true);
});

test("managed jobs support isolated_worktree and clean up detached worktrees in finally", async () => {
  const root = mkdtempSync(join(tmpdir(), "mbm-worktree-job-"));
  const workspace = join(root, "repo");
  const jobRoot = join(root, "jobs");
  const coordinatorRoot = join(root, "resource-coordinator");
  let manager = null;
  mkdirSync(workspace, { recursive: true });
  try {
    const git = resolveTrustedGitExecutable({ workspace });
    execFileSync(git, ["init"], { cwd: workspace, encoding: "utf8" });
    execFileSync(git, ["config", "user.email", "test@example.invalid"], { cwd: workspace, encoding: "utf8" });
    execFileSync(git, ["config", "user.name", "Test User"], { cwd: workspace, encoding: "utf8" });
    writeFileSync(join(workspace, "tracked.txt"), "baseline\n", "utf8");
    execFileSync(git, ["add", "tracked.txt"], { cwd: workspace, encoding: "utf8" });
    execFileSync(git, ["commit", "-m", "init"], { cwd: workspace, encoding: "utf8" });

    assert.throws(
      () => validatePlan({ isolated_worktree: "yes", steps: [{ argv: [process.execPath, "-e", ""] }] }, {
        workspace, fullEnv: false, unrestrictedPaths: false, resources: {},
      }),
      /isolated_worktree must be boolean/,
    );
    const validPlan = validatePlan({ isolated_worktree: true, steps: [{ argv: [process.execPath, "-e", ""] }] }, {
      workspace, fullEnv: false, unrestrictedPaths: false, resources: {},
    });
    assert.equal(validPlan.isolated_worktree, true);

    manager = createManagedJobTestManager({
      jobRoot,
      workspace,
      policy: { profile: "full", origin: "explicit", allowWrite: true, execMode: "shell", minimalEnv: false, unrestrictedPaths: true, exposeAbsolutePaths: true },
      authorizeTool() {},
      recover: false,
      runnerSpawnProcess: managedJobTestRunnerForCoordinatorRoot(coordinatorRoot),
    });

    const accepted = manager.start({
      name: "isolated-worktree-job",
      isolated_worktree: true,
      steps: [
        {
          name: "mutate-isolated-worktree",
          argv: [
            process.execPath,
            "-e",
            "const fs = require('node:fs'); fs.writeFileSync('scratch.txt', 'isolated'); console.log(process.cwd());",
          ],
        },
      ],
    });

    const read = await waitForJob(manager, accepted.job_id, new Set(["succeeded"]), 60_000);
    assert.equal(read.status, "succeeded");
    const stepStdout = String(read.result?.steps?.[0]?.stdout || "").trim();
    assert.match(stepStdout, /worktree$/);
    assert.equal(existsSync(join(workspace, "scratch.txt")), false);

    const worktreeList = execFileSync(git, ["worktree", "list", "--porcelain"], { cwd: workspace, encoding: "utf8" });
    const worktreeCount = worktreeList.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length;
    assert.equal(worktreeCount, 1);
  } finally {
    manager?.stopRunnerExitRecovery();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("ToolExecutor isolates principals, ignores benign reads and non-tracked errors, and validates denylist errors", async () => {
  const obs = new RuntimeObservability({ costCallThreshold: 2, costByteThreshold: 512 });
  let seq = 0;
  let activeAccount = "acct-one";
  const executor = new ToolExecutor({
    handlers: {
      browser_screenshot: async () => ({ $mcp: { content: [{ type: "image", data: PNG_A_BASE64, mimeType: "image/png" }], structuredContent: { ok: true } } }),
      computer_observe: async () => ({ snapshot_id: "snap-static", captured_at: "2026-01-01T00:00:00Z", elements: [{ ref: "b1" }] }),
      read_file: async () => ({ content: "ok" }),
      exec_command: async () => ({ code: 0 }),
    },
    policyGate: {
      assert(tool) {
        if (tool === "exec_command" && activeAccount === "denied-acct") {
          const err = new Error("denied");
          err.code = "authorization_denied";
          throw err;
        }
      },
    },
    accountAccessGate: {
      assert() {},
      authority(auth) {
        return { principal: { kind: "account", accountId: auth?.accountId || activeAccount, role: auth?.role || "owner" } };
      },
    },
    callRegistry: {
      open: (ctx) => ({ callId: `iso-${++seq}`, ...ctx }),
      finish() {},
      bindPrincipal() {},
      throwIfCancelled() {},
    },
    observability: obs,
    securityAudit: { async flush() { return true; }, async record() { return true; } },
    logger: { event() {} },
  });

  await assert.rejects(() => {
    activeAccount = "denied-acct";
    return executor.execute("exec_command", { command: "id" }, { origin: "relay", authorization: { accountId: "denied-acct", role: "owner" } });
  });
  assert.equal(obs.snapshot().cost_warning, null);

  const acctOneReq = { origin: "relay", authorization: { accountId: "acct-one", role: "owner" } };
  await executor.execute("browser_screenshot", { tab_id: 1 }, acctOneReq);
  assert.equal(executor.taintSnapshot("account:acct-one:::").untrusted_content_seen, true);
  assert.equal(executor.taintSnapshot("account:acct-two:::").untrusted_content_seen, false);
  assert.equal(executor.taintSnapshot("local").untrusted_content_seen, false);

  await executor.execute("computer_observe", { surface: "browser" }, acctOneReq);
  await executor.execute("computer_observe", { surface: "browser" }, acctOneReq);
  const looped = await executor.execute("computer_observe", { surface: "browser" }, acctOneReq);
  assert.equal(looped.$mcp === undefined, true);
  const warnings = [];
  const loopObs = new ToolExecutor({
    handlers: { computer_observe: async () => ({ snapshot_id: "s1", captured_at: "t1", semantic: { frames: [] } }) },
    policyGate: { assert() {} },
    accountAccessGate: { assert() {}, authority: () => ({ principal: { kind: "account", accountId: "acct-loop", role: "owner" } }) },
    callRegistry: { open: (ctx) => ({ callId: `c-${++seq}`, ...ctx }), finish() {}, bindPrincipal() {}, throwIfCancelled() {} },
    observability: obs,
    securityAudit: { async flush() { return true; }, async record() { return true; } },
    logger: { event(_lvl, name, data) { if (name === "tool.call.stuck_loop") warnings.push(data); } },
  });
  await loopObs.execute("computer_observe", { surface: "browser" }, { origin: "relay", authorization: { accountId: "acct-loop", role: "owner" } });
  await loopObs.execute("computer_observe", { surface: "browser" }, { origin: "relay", authorization: { accountId: "acct-loop", role: "owner" } });
  await loopObs.execute("computer_observe", { surface: "browser" }, { origin: "relay", authorization: { accountId: "acct-loop", role: "owner" } });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].pattern, "stalled_observation");

  const benign = new StuckLoopDetector(3);
  benign.record("read_file", { path: "a" }, "completed", { resultDigest: "d1" });
  benign.record("read_file", { path: "b" }, "completed", { resultDigest: "d2" });
  benign.record("read_file", { path: "a" }, "completed", { resultDigest: "d3" });
  assert.equal(benign.record("read_file", { path: "b" }, "completed", { resultDigest: "d4" }), null);
  assert.equal(benign.record("read_file", { path: "1" }, "failed", { errorCode: "authorization_denied" }), null);

  const denylistDir = mkdtempSync(join(tmpdir(), "mbm-deny-utf8-"));
  try {
    const missing = join(denylistDir, "secret-dir-name", "missing-deny");
    assert.throws(() => loadPrivacyDenylistCached(missing), (err) => !/secret-dir-name/.test(String(err.message)));
    const badUtf8 = join(denylistDir, "bad-utf8");
    writeFileSync(badUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.throws(() => loadPrivacyDenylistCached(badUtf8), /valid UTF-8/);
  } finally {
    rmSync(denylistDir, { recursive: true, force: true });
  }
});

test("Extension network redaction, BrowserOperationService wire normalization, and Worker stale-schema guidance align", async () => {
  const { context } = createNetworkVmContext();
  const obs = context.__machineBridgeDevtoolsObservation;
  const origSetTimeout = context.setTimeout;
  context.setTimeout = (fn, ms) => {
    if (ms === 5) {
      context.emitNetworkEvent(7, "Network.requestWillBeSent", {
        requestId: "r-redir",
        request: { url: "https://idp.example.test/start?nonce=n1", method: "GET", headers: {} },
      });
      context.emitNetworkEvent(7, "Network.requestWillBeSent", {
        requestId: "r-redir",
        request: {
          url: "https://auth.example.test/callback?code=c1#access_token=fragsecret",
          method: "GET",
          headers: { Referer: "https://idp.example.test/?secret=top", "Proxy-Authorization": "Basic xyz", "X-Session-Token": "tok" },
        },
        redirectResponse: {
          url: "https://idp.example.test/start?nonce=n1",
          status: 302,
          mimeType: "text/html",
          headers: { Location: "https://app.example.test/#id_token=jwt" },
        },
      });
      context.emitNetworkEvent(7, "Network.loadingFailed", { requestId: "r-redir", errorText: "net::ERR_ABORTED", canceled: true });
    }
    return origSetTimeout(fn, ms === 5 ? 0 : ms);
  };
  const log = await obs.networkLog({ tabId: 7, waitMs: 5, limit: 10 }, {});
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].status, 302);
  assert.doesNotMatch(log.entries[0].response_headers.Location, /jwt/);
  assert.doesNotMatch(log.entries[1].request_headers.Referer, /top/);
  assert.equal(log.entries[1].request_headers["Proxy-Authorization"], "[REDACTED]");
  assert.equal(log.entries[1].request_headers["X-Session-Token"], "[REDACTED]");
  assert.doesNotMatch(log.entries[1].url, /fragsecret/);
  assert.equal(log.entries[1].failed, true);

  await assert.rejects(() => obs.networkLog({ tabId: "bad" }, {}), /tabId/);
  const defaultClear = await obs.networkLog({ tabId: 7, clear: true }, {});
  assert.equal(defaultClear.cleared, true);
  context.emitTabRemoved(7);

  const calls = [];
  let gen = 1;
  const svc = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    bridgeStatus: () => ({ extensionGeneration: gen }),
    async request(method, params, timeoutSeconds) {
      calls.push({ method, params, timeoutSeconds });
      if (method === "manage_tabs" && params.action === "new") return { tab_id: 91, url: "https://a.test" };
      if (method === "list_tabs") return { tabs: [{ tab_id: 91, url: "https://a.test" }] };
      if (method === "get_source") return { frames: [{ frame_id: 0, html: "<p>ok</p>" }] };
      if (method === "inspect_page") return { tab_id: 91, frames: [{ frame_id: 0, elements: [{ ref: "r1", frame_id: 0 }] }] };
      return { ok: true };
    },
  });
  const ownerCtx = { authority: { origin: "relay", principal: { kind: "account", accountId: "owner-1", role: "owner" } } };
  const guestCtx = { authority: { origin: "relay", principal: { kind: "account", accountId: "guest-2", role: "reviewer" } } };
  await svc.manageTabs({ action: "new" }, ownerCtx);
  const guestList = await svc.listTabs({}, guestCtx);
  assert.equal(guestList.tabs[0].owned_by_caller, false);
  assert.equal(guestList.tabs[0].tab_owner, null);
  gen = 2;
  const postReset = await svc.listTabs({}, guestCtx);
  assert.equal(postReset.tabs[0].owned_by_caller, null);
  const src = await svc.getSource({ tab_id: 91 }, ownerCtx);
  assert.equal(src.frames.length, 1);
  const insp = await svc.inspectPage({ tab_id: 91, include_marks: true }, ownerCtx);
  assert.equal(insp.frames.length, 1);
  assert.equal(insp.som_marks[0].ref, "r1");
  await svc.networkLog({ tab_id: 91, timeout_seconds: 60 }, ownerCtx);
  assert.equal(calls.at(-1).timeoutSeconds, 60);
  await assert.rejects(() => svc.networkLog({ tab_id: 91, timeout_seconds: 999 }, ownerCtx), /1 to 60/);
  await svc.networkLog({ tab_id: 91, clear: true }, ownerCtx);
  assert.equal(calls.at(-1).params.waitMs, 0);

  const missingTabCall = inspectWorkerToolCall({ name: "browser_network_log", arguments: { limit: 10 } }, workspaceTools, false);
  assert.equal(missingTabCall.ok, false);
  const guidance = staleSchemaGuidanceResult(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_network_log", arguments: { limit: 10 } } },
    missingTabCall.issues,
    serverImplementation({ name: "machine-bridge-mcp", version: "test" }),
  );
  assert.equal(guidance.result.structuredContent.error.details.required_field, "tab_id");
  assert.equal(guidance.result.structuredContent.error.details.schema_refresh_recommended, true);
});

test("Worker authority_delta excludes monitor/server_info, /mcp rejects 2025-11-25, and /mcp/gemini isolates stateless instructions", async () => {
  const info = buildServerInfoResult({
    serverName: serverMetadata.name,
    serverVersion: "3.0.0-beta.223",
    base: "https://example.workers.dev",
    oauth: {},
    daemon: { connected: true, count: 1, tool_count: 5, tools: ["read_file", "server_info", "render_job_monitor", "write_file"] },
    effectiveTools: ["server_info", "read_file", "render_job_monitor"],
    advertisedTools: ["server_info", "read_file"],
    pendingSnapshot: {},
    toolListSubscription: {},
    daemonRegistry: { probingSockets: () => [], candidateSockets: () => [], readyRoleSockets: () => [], httpReadyChannels: () => [], httpCandidates: () => [] },
    observability: { snapshot: () => ({}) },
    authorization: { account: { role: "owner" }, account_role_is_owner: true, summary: {} },
  }, "full");
  assert.equal(info.authority_delta.omitted_count, 1);
  assert.deepEqual(info.authority_delta.omitted_sample, ["write_file"]);

  const geminiController = new McpController({
    capabilities: MCP_SERVER_CAPABILITIES,
    serverInfo: serverImplementation({ name: serverMetadata.name, version: "test" }),
    instructions: "Default 2026 instructions",
    stateless2025Instructions: "Gemini stateless 2025 instructions",
    supportedVersions: [MCP_PROTOCOL_VERSION, MCP_2025_PROTOCOL_VERSION],
    mcpPath: "/mcp/gemini",
    discoveryTtlMs: 0,
    toolListTtlMs: 0,
    tools: () => [serverInfoTool, ...workspaceTools, jobMonitorRenderTool],
    recordError() {},
    cancelClientRequest: async () => {},
    callTool: async () => ({ ok: true }),
  });
  const nativeController = new McpController({
    capabilities: MCP_SERVER_CAPABILITIES,
    serverInfo: serverImplementation({ name: serverMetadata.name, version: "test" }),
    instructions: "Default 2026 instructions",
    supportedVersions: [MCP_PROTOCOL_VERSION],
    mcpPath: "/mcp",
    discoveryTtlMs: 0,
    toolListTtlMs: 0,
    tools: () => [serverInfoTool, ...workspaceTools],
    recordError() {},
    cancelClientRequest: async () => {},
    callTool: async () => ({ ok: true }),
  });

  const rejectedNative = await nativeController.handleRequest({
    authorized: { tokenKey: "k", accountId: "a", accountVersion: 1, clientId: "c", familyId: "f", role: "owner" },
    base: "https://example.workers.dev",
    proxyMode: "buffered",
    mcpPath: "/mcp",
    request: new Request("https://example.workers.dev/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_2025_PROTOCOL_VERSION },
    }),
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_2025_PROTOCOL_VERSION } },
  });
  const rejectedJson = await rejectedNative.json();
  assert.equal(rejectedJson?.error?.code, -32601);

  const geminiInit = await geminiController.handleRequest({
    authorized: { tokenKey: "k", accountId: "a", accountVersion: 1, clientId: "c", familyId: "f", role: "owner" },
    base: "https://example.workers.dev",
    proxyMode: "buffered",
    mcpPath: "/mcp/gemini",
    request: new Request("https://example.workers.dev/mcp/gemini", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_2025_PROTOCOL_VERSION },
    }),
    body: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gemini", version: "1" } } },
  });
  assert.equal(geminiInit.status, 200);
  const initJson = await geminiInit.json();
  assert.equal(initJson.result.instructions, "Gemini stateless 2025 instructions");

  const disallowedUiParam = await dispatchWorkerToolCall(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_job", arguments: { job_id: `job_${"A".repeat(24)}`, ui_monitor_id: "m1" } } },
    "https://example.workers.dev",
    { tokenKey: "k", accountId: "a", accountVersion: 1, clientId: "c", familyId: "f", role: "owner" },
    new AbortController().signal,
    undefined,
    undefined,
    {
      includeJobMonitor: false,
      serverInfo: serverImplementation({ name: serverMetadata.name, version: "test" }),
      tools: () => [serverInfoTool, ...workspaceTools],
      recordError() {},
      callTool: async () => ({ ok: true }),
    },
  );
  assert.equal(disallowedUiParam.message.result.isError, true);
});

test("Managed job worktree preflight/finally cleanup, read-only CLI verify/pair, and Computer Use mark filtering hold", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mbm-job-cli-cu-"));
  const nonGitWs = join(tmp, "non-git");
  const gitWs = join(tmp, "git-repo");
  mkdirSync(nonGitWs, { recursive: true });
  mkdirSync(join(gitWs, "sub"), { recursive: true });
  try {
    assert.throws(
      () => validatePlan({ isolated_worktree: true, steps: [{ argv: [process.execPath, "-e", ""] }] }, {
        workspace: nonGitWs, fullEnv: false, unrestrictedPaths: false, resources: {},
      }),
      /not a git repository/i,
    );

    const git = resolveTrustedGitExecutable({ workspace: gitWs });
    execFileSync(git, ["init"], { cwd: gitWs, encoding: "utf8" });
    execFileSync(git, ["config", "user.email", "t@example.invalid"], { cwd: gitWs, encoding: "utf8" });
    execFileSync(git, ["config", "user.name", "Test"], { cwd: gitWs, encoding: "utf8" });
    writeFileSync(join(gitWs, "sub", "file.txt"), "hi\n", "utf8");
    execFileSync(git, ["add", "."], { cwd: gitWs, encoding: "utf8" });
    execFileSync(git, ["commit", "-m", "init"], { cwd: gitWs, encoding: "utf8" });

    const runnerSpawnProcess = managedJobTestRunnerForCoordinatorRoot(join(tmp, "resource-coordinator"));
    const manager = createManagedJobTestManager({
      jobRoot: join(tmp, "jobs"),
      workspace: join(gitWs, "sub"),
      policy: { profile: "full", origin: "explicit", allowWrite: true, execMode: "shell", minimalEnv: false, unrestrictedPaths: true, exposeAbsolutePaths: true },
      authorizeTool() {},
      recover: false,
      runnerSpawnProcess,
    });
    const job = manager.start({
      name: "failing-worktree-cleanup",
      isolated_worktree: true,
      steps: [{ name: "fail", argv: [process.execPath, "-e", "process.exit(2)"] }],
      finally_steps: [{ name: "fin", argv: [process.execPath, "-e", "console.log(process.cwd())"] }],
    });
    const st = await waitForJob(manager, job.job_id, new Set(["failed"]), 60_000);
    assert.equal(st.status, "failed");
    assert.equal(st.result.finally_steps[0].code, 0);
    assert.match(String(st.result.finally_steps[0].stdout), /worktree[\\/]sub/);
    const wtList = execFileSync(git, ["worktree", "list", "--porcelain"], { cwd: gitWs, encoding: "utf8" });
    assert.equal(wtList.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length, 1);

    const recoveryManagers = [manager];
    try {
      // Interrupted worktree recovery: clean up orphaned worktree AND refuse finally_steps if worktree vanished.
      for (const deleteBeforeRecover of [false, true]) {
        const recJob = manager.start({
          name: deleteBeforeRecover ? "recover-missing-worktree" : "recover-worktree",
          isolated_worktree: true,
          steps: [{ name: "hold", argv: [process.execPath, "-e", "setTimeout(() => {}, 30000);"] }],
          finally_steps: [{ name: "rec-fin", argv: [process.execPath, "-e", "const fs=require('node:fs'); fs.writeFileSync('rec-marker.txt', process.cwd()); console.log(process.cwd());"] }],
        });
        const recJobDir = join(tmp, "jobs", recJob.job_id);
        const wtDir = join(recJobDir, "runtime", "worktree");
        const wtDeadline = Date.now() + 15_000;
        while (!(manager.read({ job_id: recJob.job_id }).status === "running" && existsSync(wtDir) && existsSync(join(recJobDir, "active-child.json"))) && Date.now() < wtDeadline) {
          await new Promise((r) => { setTimeout(r, 25); });
        }
        assert.equal(existsSync(wtDir), true);
        const pidFile = JSON.parse(readFileSync(join(recJobDir, "runner.pid"), "utf8"));
        try { process.kill(pidFile.pid, "SIGKILL"); } catch {}
        await waitForPidExit(pidFile.pid, 10_000);
        const statusPath = join(recJobDir, "status.json");
        const stale = JSON.parse(readFileSync(statusPath, "utf8"));
        stale.updated_at = new Date(Date.now() - 60_000).toISOString();
        writeFileSync(statusPath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
        if (deleteBeforeRecover) {
          await terminateManagedJobActiveChild(join(recJobDir, "active-child.json"));
          rmSync(wtDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
        const recoveryMgr = createManagedJobTestManager({
          jobRoot: join(tmp, "jobs"),
          workspace: join(gitWs, "sub"),
          policy: { profile: "full", origin: "explicit", allowWrite: true, execMode: "shell", minimalEnv: false, unrestrictedPaths: true, exposeAbsolutePaths: true },
          authorizeTool() {},
          recover: true,
          runnerSpawnProcess,
        });
        recoveryManagers.push(recoveryMgr);
        const recState = await waitForJob(
          recoveryMgr,
          recJob.job_id,
          new Set([deleteBeforeRecover ? "recovery_failed" : "recovered"]),
          60_000,
        );
        if (deleteBeforeRecover) {
          assert.equal(recState.status, "recovery_failed");
          assert.equal(existsSync(join(gitWs, "sub", "rec-marker.txt")), false);
          execFileSync(git, ["worktree", "prune"], { cwd: gitWs, encoding: "utf8" });
        } else {
          assert.equal(recState.status, "recovered", `unexpected recovery state: ${JSON.stringify(recState)}`);
          assert.equal(existsSync(wtDir), false);
          const wtListAfterRec = execFileSync(git, ["worktree", "list", "--porcelain"], { cwd: gitWs, encoding: "utf8" });
          assert.equal(wtListAfterRec.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length, 1);
        }
      }
    } finally {
      for (const m of recoveryManagers) m.stopRunnerExitRecovery();
    }

    const nonexistentState = join(tmp, "never-created-state");
    const badFileState = join(tmp, "not-a-directory-state");
    writeFileSync(badFileState, "not-a-dir", "utf8");
    const uninitReport = await verifyCommand({ stateDir: nonexistentState, json: false });
    assert.equal(uninitReport.ok, true);
    assert.equal(uninitReport.checks.state_dir.initialized, false);
    assert.equal(existsSync(nonexistentState), false);
    const prevExitCode = process.exitCode;
    try {
      const failedReport = await verifyCommand({ stateDir: badFileState, json: false });
      assert.equal(failedReport.ok, false);
      assert.equal(process.exitCode, 1);
      assert.equal(existsSync(nonexistentState), false);
    } finally {
      process.exitCode = prevExitCode;
    }
    await assert.rejects(() => pairCommand({ role: "" }), /--role must be one of/);

    const frameSnap = browserSnapshot("https://example.test/frames", "top1");
    frameSnap.frames = [
      {
        frame_id: 0,
        snapshot_version: 3,
        truncated: false,
        document: { url: "https://example.test/frames", epoch: "doc-top" },
        elements: [
          { ref: "top1", tag: "button", role: "button", name: "", visible: true, enabled: true, bounding_box: { x: 1, y: 1, width: 20, height: 20 } },
          { ref: "hid", tag: "input", type: "hidden", role: "textbox", name: "", visible: true, enabled: true, bounding_box: { x: 1, y: 1, width: 20, height: 20 } },
          { ref: "inv", tag: "button", role: "button", name: "", visible: false, enabled: true, bounding_box: { x: 1, y: 1, width: 20, height: 20 } },
          { ref: "anc", tag: "a", role: "generic", name: "", visible: true, enabled: true, bounding_box: { x: 1, y: 1, width: 20, height: 20 } },
        ],
      },
      {
        frame_id: 5,
        snapshot_version: 3,
        truncated: false,
        document: { url: "https://child.example/f", epoch: "doc-c" },
        elements: [{ ref: "c1", tag: "button", role: "button", name: "Child", visible: true, enabled: true, bounding_box: { x: 5, y: 5, width: 30, height: 20 } }],
      },
    ];
    const hugeElements = Array.from({ length: 700 }, (_, i) => ({
      ref: `b${i}`, tag: "button", role: "button", name: `B${i}`, pad: "X".repeat(4950),
      visible: true, enabled: true, bounding_box: { x: 2, y: i * 10, width: 40, height: 20 },
    }));
    const budgetSnap = browserSnapshot("https://example.test/budget", "b0");
    budgetSnap.frames[0].frame_id = 0;
    budgetSnap.frames[0].elements = hugeElements;
    budgetSnap.total_elements = hugeElements.length;
    frameSnap.total_elements = 5;

    const mgr = managerWith({
      browser: browserStub({ inspectQueue: [frameSnap, budgetSnap] }),
      applications: appStub({
        inspectQueue: [{
          application: "SizeApp",
          process_name: "SizeApp",
          frontmost: true,
          truncated: false,
          menus_included: false,
          elements: [{ ref: "a0", role: "AXButton", name: "Go", enabled: true, screen_box: { x: 10, y: 10, width: 50, height: 24 } }],
        }],
        screenshotResult: {
          window: { id: 4, bounds: { x: 0, y: 0, width: 1234, height: 777 } },
          screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window" },
        },
      }),
    });

    const filteredRes = await mgr.observe({ surface: "browser", include_screenshot: false, include_marks: true });
    assert.equal(filteredRes.semantic.unlabeled_interactive_count, 1);
    const markRefs = new Set(filteredRes.set_of_marks.map((m) => m.ref));
    assert.equal(markRefs.has("top1"), true);
    assert.equal(markRefs.has("inv"), false);
    assert.equal(markRefs.has("c1"), false);

    const appRes = await mgr.observe({ surface: "application", application: "SizeApp", include_screenshot: true, include_marks: true });
    const appObs = appRes.$mcp.structuredContent;
    assert.match(appObs.set_of_marks_svg, /width="1234" height="777"/);

    const budgetedRes = await mgr.observe({ surface: "browser", include_screenshot: true, include_marks: true });
    const budgetedObs = budgetedRes.$mcp ? budgetedRes.$mcp.structuredContent : budgetedRes;
    assert.equal(budgetedObs.capture.screenshot, true);
    assert.equal(budgetedObs.set_of_marks, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
