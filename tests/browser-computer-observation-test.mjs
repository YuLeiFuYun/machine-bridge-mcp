import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { BrowserComputerObservationService } from "../src/local/browser-computer-observation-service.mjs";
import { BrowserOperationService } from "../src/local/browser-operation-service.mjs";
import { BridgeError } from "../src/local/errors.mjs";

const source = await readFile(new URL("../browser-extension/browser-operations.js", import.meta.url), "utf8");

await localServiceHashesReturnedScreenshotBytes();
await localServiceRejectsMalformedScreenshotEvidence();
await localServiceRejectsCoercibleSnapshotAuthority();
await localServiceEntryPointsAndLegacyFallback();
await extensionRejectsCoercibleDocumentAuthority();
await localScreenshotPreservesVerifiedMetadata();
await pairingLauncherSettlementIsNonReplayable();
await globalSalienceSelectsAcrossFrames();
await fusesChromiumAccessibilityToExecutableRef();
await mediumConfidenceFusionDoesNotCreateTrustedBinding();
await centerOnlyFusionDoesNotCreateTrustedBinding();
await conflictingNameFusionDoesNotCreateTrustedBinding();
await coercibleFusionEvidenceDoesNotCreateTrustedBinding();
await fallsBackWhenCdpObservationIsUnavailable();
await screenshotFallbackKeepsChromiumAccessibility();
await inactiveTabSkipsVisibleScreenshotFallback();
await cdpObservationCancellationDoesNotFallBack();
await visibleFallbackCancellationDoesNotPublishObservation();
await activeTabChangeDuringVisibleFallbackDropsScreenshot();
await tabClosureAtFinalObservationBoundaryRejectsSnapshot();
await rejectsRepeatedNavigationIncoherence();
await rejectsCoercibleNavigationCoherenceAuthority();
await rejectsSameDocumentHistoryEntryChangeDuringObservation();
await rejectsHistoryEntryAuthorityAppearingDuringObservation();
await rejectsSameUrlChildFrameReloadDuringObservation();
await snapshotBoundPointUsesTrustedInput();
await brokerRejectsCoercibleObservationAndVisualAuthority();
await snapshotBoundPointDragUsesTrustedInput();
await snapshotBoundPointScrollUsesTrustedInput();
await snapshotBoundPointCancellationAfterVisualVerificationSkipsInput();
await pointActionPreservesSettlementWhenTabMetadataReadFails();
await backendNodeRejectsCoercibleAuthorityBeforeInput();
await malformedCdpTrustedEvidenceCannotReachInput();
await backendNodeActionUsesViewportQuadAcrossFrames();
await backendNodeDragRevalidatesBothEndpoints();
await backendNodeDragRejectsStaleDestinationBeforeInput();
await backendNodeScrollUsesVisibleSnapshotAnchor();
await backendNodeScrollRejectsOffscreenAnchorWithoutAutoScroll();
await backendNodeQueuedCancellationSkipsDebuggerAttach();
await backendNodeMissingViewportMetricsDoesNotScroll();
await backendNodePointerScrollMakesLaterFailureUnknown();
await backendNodeCancellationDuringGeometrySkipsScroll();
await backendNodeFillUsesDomFocusAcrossFrames();
await backendNodeToggleAndSubmitUseFocusedTrustedKeys();
await backendNodeCancellationDuringInitialToggleReadSkipsFocus();
await backendNodeCancellationDuringPostFocusToggleReadSkipsInput();
await backendNodeToggleTreatsPostFocusStateFailureAsUnknown();
await backendNodeFocusFailureIsUnknownWithoutFallback();
await backendNodeResourceValueResolvesOnlyInDaemonService();
await backendNodeEpochDriftFailsBeforeInput();
await backendNodeChildFrameEpochDriftFailsBeforeInput();
await backendNodeRefIdentityDriftFailsBeforeInput();
await stalePointEpochFailsBeforeTrustedInput();
console.log("browser computer observation test ok");

async function localServiceHashesReturnedScreenshotBytes() {
  const service = new BrowserComputerObservationService({
    authorizeTool() {},
    bridgeStatus() { return { extensionInfo: { capabilities: ["computer_observation_v1"] } }; },
    async request(method) {
      assert.equal(method, "observe_computer");
      return {
        tab_id: 7, title: "Fixture", url: "https://example.test/", semantic: { frames: [] }, accessibility: null,
        viewport: { width: 800, height: 600, scale: 1 }, frame_tree: [], document_epoch: "doc",
        capture: { cdp: true, navigation_coherent: true, screenshot_source: "cdp_surface" },
        screenshot: { data: `data:image/png;base64,${PNG_BASE64}` },
      };
    },
    async inspectPage() { throw new Error("legacy inspect not expected"); },
    async screenshot() { throw new Error("legacy screenshot not expected"); },
  });
  const result = await service.observe({ include_screenshot: true });
  const expected = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
  assert.equal(result.capture.screenshot_sha256, expected);
  assert.equal(result.imageContent[0].data, PNG_BASE64);
}

async function localServiceRejectsMalformedScreenshotEvidence() {
  for (const data of [
    "data:image/png;base64,QUJD",
    `data:image/png;base64,${PNG_BASE64}=`,
    `data:image/jpeg;base64,${PNG_BASE64}`,
  ]) {
    const service = new BrowserComputerObservationService({
      authorizeTool() {},
      bridgeStatus() { return { extensionInfo: { capabilities: ["computer_observation_v1"] } }; },
      async request() {
        return {
          tab_id: 7, title: "Fixture", url: "https://example.test/", semantic: { frames: [] }, accessibility: null,
          viewport: { width: 800, height: 600, scale: 1 }, frame_tree: [], document_epoch: "doc",
          capture: { cdp: true, navigation_coherent: true, screenshot_source: "cdp_surface" }, screenshot: { data },
        };
      },
      async inspectPage() { throw new Error("legacy inspect not expected"); },
      async screenshot() { throw new Error("legacy screenshot not expected"); },
    });
    await assert.rejects(() => service.observe({ include_screenshot: true }),
      /browser extension returned an invalid computer observation screenshot/);
  }
}

async function localServiceRejectsCoercibleSnapshotAuthority() {
  const requested = [];
  const service = new BrowserComputerObservationService({
    authorizeTool() {},
    async request(method, params) { requested.push({ method, params }); return { ok: true }; },
    bridgeStatus() { return { extensionInfo: { capabilities: ["computer_observation_v1"] } }; },
    async inspectPage() { return {}; },
    async screenshot() { return {}; },
  });
  await assert.rejects(
    () => service.backendNodeAction({ action: "click", backend_node_id: "42", extension_frame_id: 0 }),
    /backend_node_id must be a positive integer/,
  );
  await assert.rejects(
    () => service.backendNodeAction({ action: "click", backend_node_id: 42, extension_frame_id: "0" }),
    /extension_frame_id must be a non-negative integer/,
  );
  await assert.rejects(
    () => service.backendNodeAction({
      action: "click", backend_node_id: 42, extension_frame_id: 0, frame_document_epoch: ["doc-1"],
    }),
    /document_epoch is invalid/,
  );
  await assert.rejects(
    () => service.backendNodeAction({
      action: "click", backend_node_id: 42, extension_frame_id: 0, frame_url: ["https://example.test/"],
    }),
    /frame_url is invalid/,
  );
  await assert.rejects(
    () => service.pointAction({
      action: "click", normalized_x: 0.5, normalized_y: 0.5, screenshot_sha256: ["a".repeat(64)],
    }),
    /screenshot_sha256 must be a SHA-256 hex digest/,
  );
  for (const args of [
    { action: ["click"], normalized_x: 0.5, normalized_y: 0.5, screenshot_sha256: "a".repeat(64) },
    { action: "click", normalized_x: "0.5", normalized_y: 0.5, screenshot_sha256: "a".repeat(64) },
    { action: "click", normalized_x: 0.5, normalized_y: [0.5], screenshot_sha256: "a".repeat(64) },
    { action: "click", normalized_x: 0.5, normalized_y: 0.5, viewport: { width: "800", height: 600, scale: 1 }, screenshot_sha256: "a".repeat(64) },
    { action: "click", normalized_x: 0.5, normalized_y: 0.5, viewport: { width: 800, height: [600], scale: 1 }, screenshot_sha256: "a".repeat(64) },
    { action: "click", normalized_x: 0.5, normalized_y: 0.5, screenshot_sha256: "a".repeat(64), timeout_seconds: "30" },
  ]) {
    await assert.rejects(() => service.pointAction(args), /(visual point action|must be a number|positive number|expected an integer)/);
  }
  await assert.rejects(
    () => service.backendNodeAction({ action: ["click"], backend_node_id: 42, extension_frame_id: 0 }),
    /snapshot backend action must be/,
  );
  await assert.rejects(
    () => service.backendNodeAction({ action: "fill", backend_node_id: 42, extension_frame_id: 0, value: ["text"] }),
    /value must be a string/,
  );
  await assert.rejects(
    () => service.backendNodeAction({ action: "press", backend_node_id: 42, extension_frame_id: 0, key: ["Enter"] }),
    /key must be a string/,
  );
  for (const args of [
    { include_screenshot: "false" },
    { include_values: [false] },
    { all_frames: null },
    { screenshot_format: ["png"] },
    { screenshot_quality: "90" },
    { focus_query: ["save"] },
  ]) {
    await assert.rejects(() => service.observe(args), /(must be boolean|must be png or jpeg|expected an integer|focus_query must be a string)/);
  }
  assert.equal(requested.length, 0, "coercible snapshot authority crossed the daemon/extension boundary");
}

async function localServiceEntryPointsAndLegacyFallback() {
  const requests = [];
  let legacyScreenshots = 0;
  const service = new BrowserComputerObservationService({
    authorizeTool() {},
    bridgeStatus() { return { extensionInfo: { capabilities: [] } }; },
    async request(method, params, timeoutSeconds) {
      requests.push({ method, params, timeoutSeconds });
      return { ok: true };
    },
    async inspectPage() {
      return {
        tab_id: 7, title: "Legacy", url: "https://legacy.example/", truncated: false,
        frames: [{ frame_id: 0, document: { epoch: "legacy-doc" }, elements: [], truncated: false }],
      };
    },
    async screenshot() {
      legacyScreenshots += 1;
      return { $mcp: { content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] } };
    },
  });
  await service.documentState({ tab_id: 7, timeout_seconds: 4 });
  const prepared = service.preflightBackendNodeAction({ action: "click", backend_node_id: 42, extension_frame_id: 0 });
  assert.equal(prepared.payload.backendNodeId, 42);
  await service.backendNodeAction({ action: "click", backend_node_id: 42, extension_frame_id: 0, timeout_seconds: 4 });
  await service.pointAction({
    action: "click", normalized_x: 0.25, normalized_y: 0.75, screenshot_sha256: "a".repeat(64),
    viewport: { width: 800, height: 600, scale: 1 }, timeout_seconds: 4,
  });
  const legacy = await service.observe({ include_screenshot: true, timeout_seconds: 4 });
  assert.equal(legacy.capture.coherence, "legacy_extension_without_computer_observation_v1");
  assert.equal(legacy.capture.semantic_epoch, "legacy-doc");
  assert.equal(legacy.imageContent.length, 1);
  assert.equal(legacyScreenshots, 1);
  assert.deepEqual(requests.map((entry) => entry.method), ["document_state", "backend_node_action", "point_action"]);
}

async function extensionRejectsCoercibleDocumentAuthority() {
  const context = createContext(null, {
    documentState: () => ({
      epoch: ["doc-stable"], url: "https://example.test/", ready_state: "complete",
      _machine_history_entry_key: "history-stable",
      viewport: { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
    }),
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("document_state", { tabId: 7 }, {}),
    /snapshot authority string is invalid/,
  );
}

async function localScreenshotPreservesVerifiedMetadata() {
  const service = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    async request(method) {
      assert.equal(method, "screenshot");
      return {
        tab_id: 7,
        title: "Captured target",
        url: "https://example.test/after-capture",
        tab_metadata_verified: true,
        data: `data:image/png;base64,${PNG_BASE64}`,
      };
    },
    bridgeStatus() { return { extensionInfo: { capabilities: [] } }; },
    extensionPath: "/fixture/extension",
    expectedExtensionVersion: "fixture",
    expectedExtensionId: "fixture",
    async runProcess() { return { code: 0, stdout: "", stderr: "" }; },
    async readResourceText() { return ""; },
    readResourceBinary() { return { buffer: Buffer.alloc(0), path: "", size: 0 }; },
  });
  const result = await service.screenshot({ tab_id: 7, format: "png" });
  assert.equal(result.$mcp.structuredContent.tab_id, 7);
  assert.equal(result.$mcp.structuredContent.title, "Captured target");
  assert.equal(result.$mcp.structuredContent.url, "https://example.test/after-capture");
  assert.equal(result.$mcp.structuredContent.tab_metadata_verified, true);
  assert.equal(result.$mcp.content[0].data, PNG_BASE64);
}

async function pairingLauncherSettlementIsNonReplayable() {
  let cancelled = false;
  let launcherCalls = 0;
  let launcherOptions = null;
  const service = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    async request() { throw new Error("pairing test must not send an extension request"); },
    bridgeStatus() {
      return {
        port: 3210, brokerRole: "owner", runtime_clients: 0, routed_requests: 0,
        extensionConnected: false, extensionInfo: null, extensionReloadRequired: false,
      };
    },
    async createPairingLaunch(port) { return { url: `http://127.0.0.1:${port}/pair?grant=fixture`, close() {} }; },
    extensionPath: "/fixture/extension",
    expectedExtensionVersion: "fixture",
    expectedExtensionId: "fixture",
    async runProcess(...args) {
      launcherCalls += 1;
      launcherOptions = args.at(-1);
      throw new BridgeError("execution_failed", "launcher response lost", {
        details: { reason: "process_outcome_unknown_after_spawn", trigger: "process_error" },
      });
    },
    async readResourceText() { return ""; },
    readResourceBinary() { return { buffer: Buffer.alloc(0), path: "", size: 0 }; },
    throwIfCancelled() { if (cancelled) throw new Error("browser pair request cancelled"); },
  });

  await assert.rejects(
    () => service.pair({ open: true }),
    /pairing page may have been opened.*outcome is unknown/i,
    "pairing launcher response loss was incorrectly treated as proof that the page did not open",
  );
  assert.equal(launcherCalls, 1, "pairing launcher failure replayed the OS open command");
  assert.equal(launcherOptions?.nonReplayableMutation, true,
    "pairing launcher did not mark the OS open process as a non-replayable mutation");
  await assert.rejects(() => service.pair({ open: [false] }), /open must be boolean/,
    "coercible pairing open flag reached launcher selection");
  assert.equal(launcherCalls, 1, "malformed pairing open flag reached the OS launcher");

  const definiteFailureService = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    async request() { throw new Error("pairing test must not send an extension request"); },
    bridgeStatus: () => service.bridgeStatus(),
    async createPairingLaunch(port) { return { url: `http://127.0.0.1:${port}/pair?grant=fixture`, close() {} }; },
    extensionPath: "/fixture/extension",
    expectedExtensionVersion: "fixture",
    expectedExtensionId: "fixture",
    async runProcess() { throw new BridgeError("policy_denied", "launcher blocked before spawn"); },
    async readResourceText() { return ""; },
    readResourceBinary() { return { buffer: Buffer.alloc(0), path: "", size: 0 }; },
  });
  await assert.rejects(
    () => definiteFailureService.pair({ open: true }),
    (error) => error instanceof BridgeError && error.code === "policy_denied" && error.message === "launcher blocked before spawn",
    "definite pairing launcher policy failure before spawn was incorrectly promoted to an unknown page-open outcome",
  );

  const failedSpawnService = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    async request() { throw new Error("pairing test must not send an extension request"); },
    bridgeStatus: () => service.bridgeStatus(),
    async createPairingLaunch(port) { return { url: `http://127.0.0.1:${port}/pair?grant=fixture`, close() {} }; },
    extensionPath: "/fixture/extension",
    expectedExtensionVersion: "fixture",
    expectedExtensionId: "fixture",
    async runProcess() { throw new BridgeError("execution_failed", "spawn /private/tmp/mbm-browser-secret ENOENT", {
      details: { reason: "process_failed_before_spawn" },
    }); },
    async readResourceText() { return ""; },
    readResourceBinary() { return { buffer: Buffer.alloc(0), path: "", size: 0 }; },
  });
  await assert.rejects(
    () => failedSpawnService.pair({ open: true }),
    (error) => error instanceof BridgeError
      && error.code === "unavailable"
      && error.retryable === true
      && error.details?.reason === "browser_pairing_launcher_unavailable_before_dispatch"
      && !error.message.includes("/private/tmp"),
    "pairing launcher spawn failure leaked private launch details or lost definite retryable settlement",
  );

  cancelled = true;
  await assert.rejects(() => service.pair({ open: true }), /browser pair request cancelled/,
    "pairing cancellation immediately before launcher dispatch was not preserved as definite");
  assert.equal(launcherCalls, 1, "pairing launcher started after cancellation was observed");
}

async function globalSalienceSelectsAcrossFrames() {
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    frameFixtures: [
      {
        frameId: 0, url: "https://example.test/",
        inspect: {
          snapshot_version: 3, document: { epoch: "doc-main", url: "https://example.test/", focus_query_match_count: 0, focus_query_search_exhaustive: true }, truncated: false,
          elements: [{ ref: "e-main", role: "button", name: "Menu", salience_score: 50 }],
        },
      },
      {
        frameId: 5, url: "https://checkout.example/",
        inspect: {
          snapshot_version: 3, document: { epoch: "doc-sub", url: "https://checkout.example/", focus_query_match_count: 1, focus_query_search_exhaustive: true }, truncated: false,
          elements: [{ ref: "e-checkout", role: "button", name: "Checkout", salience_score: 260 }],
        },
      },
      {
        frameId: 6, url: "https://malformed.example/",
        inspect: {
          snapshot_version: 3, document: { epoch: "doc-malformed", url: "https://malformed.example/", focus_query_match_count: [99], focus_query_search_exhaustive: true }, truncated: false,
          elements: [{ ref: "e-malformed", role: "button", name: "Malformed", salience_score: [999] }],
        },
      },
    ],
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("inspect_page", {
    tabId: 7, allFrames: true, maxElements: 1, focusQuery: "Checkout",
  }, {});
  assert.equal(result.total_elements, 1);
  assert.equal(result.selection.strategy, "global_salience");
  assert.equal(result.selection.frames_scanned, 3);
  assert.equal(result.selection.probed_elements, 3);
  assert.equal(result.selection.query_matched, true);
  assert.equal(result.selection.query_match_count, 1);
  assert.equal(result.selection.query_search_exhaustive, true);
  assert.equal(result.frames.find((frame) => frame.frame_id === 5)?.elements[0]?.ref, "e-checkout", "global salience did not preserve the higher-value subframe control");
  assert.equal(result.frames.find((frame) => frame.frame_id === 0)?.elements.length, 0, "lower-value main-frame control incorrectly consumed the aggregate budget");
  assert.equal(result.frames.find((frame) => frame.frame_id === 6)?.elements.length, 0,
    "coercible salience score displaced a native-scored Computer Use candidate");
}

async function fusesChromiumAccessibilityToExecutableRef() {
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", parent_id: "", loader_id: "loader-a", url: "https://example.test/", name: "" }],
        accessibility: {
          kind: "chromium-accessibility",
          nodes: [{
            ax_id: "ax-save",
            backend_dom_node_id: 42,
            frame_id: "cdp-root",
            role: "button",
            name: "Save",
            clickable: true,
            bounding_box: { x: 10, y: 20, width: 100, height: 30 },
          }],
          returned_nodes: 1,
          observed_nodes: 1,
          ignored_nodes: 0,
          truncated: false,
        },
        viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
        screenshot: { mime_type: "image/png", data: PNG_BASE64 },
      };
    },
  }, {
    captureVisibleTab: async () => { visibleTabCaptures += 1; return "data:image/png;base64,RkFMTEJBQ0s="; },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7,
    allFrames: true,
    maxElements: 20,
    maxAxNodes: 20,
    includeScreenshot: true,
    format: "png",
    quality: 90,
  }, {});
  assert.equal(result.capture.navigation_coherent, true);
  assert.equal(result.capture.cdp, true);
  assert.equal(result.capture.screenshot_source, "cdp_surface");
  assert.equal(result.screenshot.data, `data:image/png;base64,${PNG_BASE64}`);
  assert.equal(visibleTabCaptures, 0, "CDP screenshot path unexpectedly activated captureVisibleTab fallback");
  const node = result.accessibility.nodes[0];
  assert.equal(node.action_ref, "e-save", "high-confidence AX node was not fused to the executable DOM ref");
  assert.equal(node.action_ref_confidence, "high");
  const fusedElement = result.semantic.frames[0].elements.find((element) => element.ref === "e-save");
  assert.equal(fusedElement._machine_backend_node_id, 42, "extension observation did not retain the private backend-node binding for Computer Use");
}

async function mediumConfidenceFusionDoesNotCreateTrustedBinding() {
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-medium:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", parent_id: "", loader_id: "loader-medium", url: "https://example.test/", name: "" }],
        accessibility: {
          kind: "chromium-accessibility",
          nodes: [{
            ax_id: "ax-medium-save",
            backend_dom_node_id: 43,
            frame_id: "cdp-root",
            role: "button",
            name: "Save",
            clickable: true,
            bounding_box: { x: 600, y: 500, width: 100, height: 30 },
          }],
          returned_nodes: 1,
          observed_nodes: 1,
          ignored_nodes: 0,
          truncated: false,
        },
        viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
        screenshot: null,
      };
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7, allFrames: true, maxElements: 20, maxAxNodes: 20, includeScreenshot: false,
  }, {});
  const node = result.accessibility.nodes[0];
  const element = result.semantic.frames[0].elements.find((item) => item.ref === "e-save");
  assert.equal(node.action_ref, "e-save", "medium-confidence AX correlation was unnecessarily discarded as observation evidence");
  assert.equal(node.action_ref_confidence, "medium");
  assert.equal(Object.hasOwn(element, "_machine_backend_node_id"), false,
    "medium-confidence AX correlation received an executable Chromium backend-node binding");
  assert.equal(Object.hasOwn(element, "_machine_cdp_frame_id"), false,
    "medium-confidence AX correlation received a private CDP frame binding");
}

async function centerOnlyFusionDoesNotCreateTrustedBinding() {
  const result = await observeDefaultFusionNode({
    ax_id: "ax-center-only",
    backend_dom_node_id: 44,
    frame_id: "cdp-root",
    role: "button",
    name: "Save",
    clickable: true,
    bounding_box: { x: 55, y: -115, width: 10, height: 300 },
  });
  const node = result.accessibility.nodes[0];
  const element = result.semantic.frames[0].elements.find((item) => item.ref === "e-save");
  assert.equal(node.action_ref, "e-save");
  assert.equal(node.action_ref_confidence, "medium",
    "center-aligned but geometrically incompatible AX/DOM boxes were promoted to executable high confidence");
  assert.equal(Object.hasOwn(element, "_machine_backend_node_id"), false);
}

async function conflictingNameFusionDoesNotCreateTrustedBinding() {
  const result = await observeDefaultFusionNode({
    ax_id: "ax-conflicting-name",
    backend_dom_node_id: 45,
    frame_id: "cdp-root",
    role: "button",
    name: "Delete",
    clickable: true,
    bounding_box: { x: 10, y: 20, width: 100, height: 30 },
  });
  const node = result.accessibility.nodes[0];
  const element = result.semantic.frames[0].elements.find((item) => item.ref === "e-save");
  assert.equal(node.action_ref, "e-save", "strong geometry correlation was unexpectedly discarded instead of remaining observational evidence");
  assert.equal(node.action_ref_confidence, "medium",
    "conflicting accessible names were promoted to executable high confidence despite matching geometry");
  assert.equal(Object.hasOwn(element, "_machine_backend_node_id"), false);
}

async function coercibleFusionEvidenceDoesNotCreateTrustedBinding() {
  const malformedIdentity = await observeDefaultFusionNode({
    ax_id: "ax-coercible-identity", backend_dom_node_id: 46, frame_id: "cdp-root",
    role: ["button"], name: ["Save"], clickable: true,
    bounding_box: { x: 10, y: 20, width: 100, height: 30 },
  });
  const identityNode = malformedIdentity.accessibility.nodes[0];
  const identityElement = malformedIdentity.semantic.frames[0].elements.find((item) => item.ref === "e-save");
  assert.equal(identityNode.action_ref_confidence, "medium",
    "coercible AX identity was promoted to executable fusion confidence");
  assert.equal(Object.hasOwn(identityElement, "_machine_backend_node_id"), false,
    "coercible AX identity created a trusted Chromium backend-node binding");

  const malformedGeometry = await observeDefaultFusionNode({
    ax_id: "ax-coercible-geometry", backend_dom_node_id: 47, frame_id: "cdp-root",
    role: "button", name: "Save", clickable: true,
    bounding_box: { x: "10", y: 20, width: 100, height: 30 },
  });
  const geometryNode = malformedGeometry.accessibility.nodes[0];
  const geometryElement = malformedGeometry.semantic.frames[0].elements.find((item) => item.ref === "e-save");
  assert.equal(geometryNode.action_ref_confidence, "medium",
    "coercible AX geometry was promoted to executable fusion confidence");
  assert.equal(Object.hasOwn(geometryElement, "_machine_backend_node_id"), false,
    "coercible AX geometry created a trusted Chromium backend-node binding");
}

async function observeDefaultFusionNode(node) {
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-fusion:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", parent_id: "", loader_id: "loader-fusion", url: "https://example.test/", name: "" }],
        accessibility: {
          kind: "chromium-accessibility",
          nodes: [node],
          returned_nodes: 1,
          observed_nodes: 1,
          ignored_nodes: 0,
          truncated: false,
        },
        viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
        screenshot: null,
      };
    },
  });
  return context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7, allFrames: true, maxElements: 20, maxAxNodes: 20, includeScreenshot: false,
  }, {});
}

async function fallsBackWhenCdpObservationIsUnavailable() {
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture() { throw new Error("debugger already attached"); },
  }, {
    captureVisibleTab: async () => { visibleTabCaptures += 1; return "data:image/png;base64,RkFMTEJBQ0s="; },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7,
    allFrames: true,
    maxElements: 20,
    includeScreenshot: true,
  }, {});
  assert.equal(result.capture.cdp, false);
  assert.equal(result.capture.navigation_coherent, true);
  assert.equal(result.capture.fallback_reason, "cdp_observation_unavailable");
  assert.equal(result.capture.screenshot_source, "capture_visible_tab_fallback");
  assert.equal(visibleTabCaptures, 1);
  assert.equal(result.accessibility, null);
}

async function screenshotFallbackKeepsChromiumAccessibility() {
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/", navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { available: true, nodes: [{ ax_id: "ax-save", backend_dom_node_id: 42, frame_id: "cdp-root", role: "button", name: "Save", clickable: true, bounding_box: { x: 10, y: 20, width: 100, height: 30 } }] },
        components: { accessibility: true, dom_snapshot: true, screenshot_requested: true, screenshot: false, layout_metrics: true },
        viewport: { width: 800, height: 600, scale: 1 }, screenshot: null,
      };
    },
  }, {
    captureVisibleTab: async () => { visibleTabCaptures += 1; return "data:image/png;base64,RkFMTEJBQ0s="; },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: true,
  }, {});
  assert.equal(result.capture.cdp, true);
  assert.equal(result.capture.cdp_components.screenshot, false);
  assert.equal(result.capture.screenshot_source, "capture_visible_tab_fallback");
  assert.equal(result.accessibility.nodes[0]?.ax_id, "ax-save");
  assert.equal(result.accessibility.nodes[0]?.action_ref, "e-save");
  assert.equal(visibleTabCaptures, 1);
}

async function inactiveTabSkipsVisibleScreenshotFallback() {
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture() { throw new Error("debugger unavailable"); },
  }, {
    queryTabs(query, tab) {
      if (query?.active && query.windowId === tab.windowId) {
        return [{ id: 99, windowId: tab.windowId, active: true, title: "User active", url: "https://other.example/" }];
      }
      return [{ ...tab }];
    },
    captureVisibleTab: async () => { visibleTabCaptures += 1; return "data:image/png;base64,RkFMTEJBQ0s="; },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: true,
  }, {});
  assert.equal(result.capture.navigation_coherent, true);
  assert.equal(result.capture.screenshot_source, "none");
  assert.equal(result.capture.screenshot_fallback_reason, "visible_tab_fallback_skipped_inactive_target");
  assert.equal(result.capture.coherence, "stable_extension_document_epoch_without_screenshot");
  assert.equal(result.screenshot, null);
  assert.equal(visibleTabCaptures, 0, "Computer Use activated an inactive target tab for a visible-tab screenshot fallback");
}

async function cdpObservationCancellationDoesNotFallBack() {
  const state = { cancelled: false };
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture(_tabId, _options, captureState) {
      captureState.cancelled = true;
      throw new Error("browser request cancelled");
    },
  }, {
    captureVisibleTab: async () => { visibleTabCaptures += 1; return "data:image/png;base64,RkFMTEJBQ0s="; },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: true,
    }, state),
    /browser request cancelled/,
  );
  assert.equal(visibleTabCaptures, 0, "cancelled CDP observation incorrectly fell back to visible-tab capture");
}

async function visibleFallbackCancellationDoesNotPublishObservation() {
  const state = { cancelled: false };
  let visibleTabCaptures = 0;
  const context = createContext({
    async capture() { throw new Error("debugger unavailable"); },
  }, {
    captureVisibleTab: async () => {
      visibleTabCaptures += 1;
      state.cancelled = true;
      return "data:image/png;base64,RkFMTEJBQ0s=";
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: true,
    }, state),
    /browser request cancelled/,
  );
  assert.equal(visibleTabCaptures, 1, "fallback cancellation fixture did not reach the visible-tab capture boundary");
}

async function activeTabChangeDuringVisibleFallbackDropsScreenshot() {
  let activeTabId = 7;
  const context = createContext({
    async capture() { throw new Error("debugger unavailable"); },
  }, {
    queryTabs(query, tab) {
      if (query?.active && query.windowId === tab.windowId) {
        return [{ id: activeTabId, windowId: tab.windowId, active: true, title: "Active", url: activeTabId === tab.id ? tab.url : "https://other.example/" }];
      }
      return [{ ...tab }];
    },
    captureVisibleTab: async () => {
      activeTabId = 99;
      return "data:image/png;base64,V1JPTkdUQUI=";
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
    tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: true,
  }, {});
  assert.equal(result.capture.navigation_coherent, true);
  assert.equal(result.capture.screenshot_source, "none");
  assert.equal(result.capture.screenshot_fallback_reason, "visible_tab_fallback_unavailable");
  assert.equal(result.screenshot, null, "Computer Use published a fallback screenshot after the active tab changed during capture");
}

async function tabClosureAtFinalObservationBoundaryRejectsSnapshot() {
  let tabReads = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] },
        viewport: { width: 800, height: 600, scale: 1 },
        screenshot: null,
      };
    },
  }, {
    getTab(tab) {
      tabReads += 1;
      if (tabReads >= 3) throw new Error("No tab with id: 7");
      return { ...tab };
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /browser tab became unavailable during computer observation/,
  );
}

async function rejectsRepeatedNavigationIncoherence() {
  let documentStateCalls = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] },
        viewport: null,
        screenshot: null,
      };
    },
  }, {
    documentState: () => {
      documentStateCalls += 1;
      return { epoch: "doc-replaced", url: "https://example.test/", ready_state: "complete" };
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /page changed during computer observation/,
  );
  assert.equal(documentStateCalls, 4,
    "incoherent observation did not perform one pre/post authority pair per attempt across the single retry");
}

async function rejectsCoercibleNavigationCoherenceAuthority() {
  const malformedCdp = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/", navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: ["https://example.test/"] }],
        accessibility: { nodes: [] }, viewport: null, screenshot: null,
      };
    },
  });
  await assert.rejects(
    () => malformedCdp.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /snapshot authority string is invalid/,
  );

  const malformedPostState = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/", navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] }, viewport: null, screenshot: null,
      };
    },
  }, {
    documentState: () => ({
      epoch: "doc-stable", url: ["https://example.test/"], ready_state: "complete", _machine_history_entry_key: "history-stable",
      viewport: { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
    }),
  });
  await assert.rejects(
    () => malformedPostState.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /snapshot authority string is invalid/,
  );
}

async function rejectsSameDocumentHistoryEntryChangeDuringObservation() {
  let historyReads = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] },
        viewport: null,
        screenshot: null,
      };
    },
  }, {
    documentState: () => ({
      epoch: "doc-stable",
      url: "https://example.test/",
      ready_state: "complete",
      _machine_history_entry_key: (historyReads++ % 2 === 0) ? "history-before" : "history-after",
    }),
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /page changed during computer observation/,
  );
  assert.equal(historyReads, 4, "same-document history drift was not retried exactly once before rejection");
}

async function rejectsHistoryEntryAuthorityAppearingDuringObservation() {
  let historyReads = 0;
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] },
        viewport: null,
        screenshot: null,
      };
    },
  }, {
    documentState: () => ({
      epoch: "doc-stable",
      url: "https://example.test/",
      ready_state: "complete",
      _machine_history_entry_key: (historyReads++ % 2 === 0) ? "" : "history-now-available",
    }),
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /page changed during computer observation/,
  );
  assert.equal(historyReads, 4,
    "history authority appearing mid-observation was not retried exactly once before rejection");
}

async function rejectsSameUrlChildFrameReloadDuringObservation() {
  let childStateReads = 0;
  const frameFixtures = [
    {
      frameId: 0, url: "https://example.test/",
      inspect: {
        snapshot_version: 3,
        document: { epoch: "doc-main-stable", url: "https://example.test/" },
        elements: [{ ref: "e-main", role: "button", name: "Main", visible: true, enabled: true }],
        truncated: false,
      },
    },
    {
      frameId: 5, url: "https://child.example/frame",
      inspect: {
        snapshot_version: 3,
        document: { epoch: "doc-child-before", url: "https://child.example/frame" },
        elements: [{ ref: "e-child", role: "button", name: "Child", visible: true, enabled: true }],
        truncated: false,
      },
    },
  ];
  const context = createContext({
    async capture() {
      return {
        document_epoch: "cdp-root:loader-a:https://example.test/",
        navigation_coherent: true,
        frame_tree: [{ id: "cdp-root", url: "https://example.test/" }],
        accessibility: { nodes: [] }, viewport: null, screenshot: null,
      };
    },
  }, {
    frameFixtures,
    frameDocumentState(frame) {
      if (frame.frameId === 5) {
        childStateReads += 1;
        return { epoch: "doc-child-after", url: frame.url, ready_state: "complete" };
      }
      return { epoch: frame.inspect.document.epoch, url: frame.url, ready_state: "complete" };
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("observe_computer", {
      tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false,
    }, {}),
    /page changed during computer observation/,
  );
  assert.equal(childStateReads, 2, "same-URL child-frame reload did not invalidate both bounded observation attempts");
}

async function brokerRejectsCoercibleObservationAndVisualAuthority() {
  let cdpCaptures = 0;
  let visibleCaptures = 0;
  let trustedDispatches = 0;
  const context = createContext({
    async capture() { cdpCaptures += 1; throw new Error("must not capture"); },
  }, {
    captureVisibleTab: async () => { visibleCaptures += 1; return "data:image/png;base64,AAAA"; },
    devtoolsInput: {
      async perform() { trustedDispatches += 1; },
      async performWithSend() { trustedDispatches += 1; },
    },
  });
  for (const params of [
    { tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: "false" },
    { tabId: 7, allFrames: [true], maxElements: 20, includeScreenshot: false },
    { tabId: 7, allFrames: true, maxElements: "20", includeScreenshot: false },
    { tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false, quality: "90" },
    { tabId: 7, allFrames: true, maxElements: 20, includeScreenshot: false, format: ["png"] },
  ]) await assert.rejects(() => context.__machineBridgeBrowserOperations.dispatch("observe_computer", params, {}), /invalid|must be boolean/);
  assert.equal(cdpCaptures, 0, "coercible observation metadata reached CDP capture");
  assert.equal(visibleCaptures, 0, "coercible observation metadata triggered a visible-tab screenshot");

  const basePoint = {
    tabId: 7, action: "click", normalizedX: 0.5, normalizedY: 0.25,
    expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
    expectedScreenshotSha256: "a".repeat(64), screenshotFormat: "png", screenshotQuality: 90,
  };
  for (const patch of [
    { tabId: "7" },
    { expectedDocumentEpoch: null },
    { expectedDocumentEpoch: undefined },
    { expectedViewport: null },
    { expectedViewport: { width: "800", height: 600, scale: 1 } },
    { expectedScreenshotSha256: "" },
    { expectedScreenshotSha256: ["a".repeat(64)] },
    { screenshotFormat: ["png"] },
    { screenshotQuality: "90" },
  ]) await assert.rejects(() => context.__machineBridgeBrowserOperations.dispatch("point_action", { ...basePoint, ...patch }, {}), /invalid|required before dispatch/);
  assert.equal(trustedDispatches, 0, "coercible visual authority reached trusted input");
}

async function snapshotBoundPointUsesTrustedInput() {
  const dispatches = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsInput: { async perform(tabId, action, details) { dispatches.push({ tabId, action, details }); } },
  });
  const visualDigest = "a".repeat(64);
  const result = await context.__machineBridgeBrowserOperations.dispatch("point_action", {
    tabId: 7, action: "click", normalizedX: 0.5, normalizedY: 0.25,
    expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
    expectedScreenshotSha256: visualDigest, screenshotFormat: "png", screenshotQuality: 90,
  }, {});
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].details.point.x, 400);
  assert.equal(dispatches[0].details.point.y, 150);
  assert.equal(dispatches[0].details.expectedScreenshotSha256, visualDigest);
  assert.equal(dispatches[0].details.screenshotFormat, "png");
  assert.equal(result.input_mode, "trusted");
  assert.equal(result.point.normalized_x, 0.5);
  assert.equal(result.hit.ref, "e-hit");
  assert.equal(result.tab_metadata_verified, true);
}

async function snapshotBoundPointDragUsesTrustedInput() {
  const dispatches = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsInput: { async perform(tabId, action, details) { dispatches.push({ tabId, action, details }); } },
  });
  const visualDigest = "b".repeat(64);
  const result = await context.__machineBridgeBrowserOperations.dispatch("point_action", {
    tabId: 7, action: "drag", normalizedX: 0.25, normalizedY: 0.25,
    destinationNormalizedX: 0.75, destinationNormalizedY: 0.5,
    expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
    expectedScreenshotSha256: visualDigest, screenshotFormat: "png", screenshotQuality: 90,
  }, {});
  assert.equal(dispatches.length, 1, "point drag dispatched more than one trusted input operation");
  assert.equal(dispatches[0].action, "drag");
  assert.equal(dispatches[0].details.point.x, 200);
  assert.equal(dispatches[0].details.point.y, 150);
  assert.equal(dispatches[0].details.destinationPoint.x, 600);
  assert.equal(dispatches[0].details.destinationPoint.y, 300);
  assert.equal(dispatches[0].details.expectedScreenshotSha256, visualDigest);
  assert.equal(result.point.normalized_x, 0.25);
  assert.equal(result.destination_point.normalized_x, 0.75);
  assert.equal(result.hit.ref, "e-hit");
  assert.equal(result.destination_hit.ref, "e-hit");
}

async function snapshotBoundPointScrollUsesTrustedInput() {
  const dispatches = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsInput: { async perform(tabId, action, details) { dispatches.push({ tabId, action, details }); } },
  });
  const visualDigest = "c".repeat(64);
  const result = await context.__machineBridgeBrowserOperations.dispatch("point_action", {
    tabId: 7, action: "scroll", normalizedX: 0.4, normalizedY: 0.6,
    deltaX: -120, deltaY: 640,
    expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
    expectedScreenshotSha256: visualDigest, screenshotFormat: "png", screenshotQuality: 90,
  }, {});
  assert.equal(dispatches.length, 1, "point scroll dispatched more than one trusted input operation");
  assert.equal(dispatches[0].action, "scroll");
  assert.equal(dispatches[0].details.point.x, 320);
  assert.equal(dispatches[0].details.point.y, 360);
  assert.equal(dispatches[0].details.deltaX, -120);
  assert.equal(dispatches[0].details.deltaY, 640);
  assert.equal(dispatches[0].details.expectedScreenshotSha256, visualDigest);
  assert.equal(result.point.normalized_x, 0.4);
  assert.equal(result.scroll_delta.delta_x, -120);
  assert.equal(result.scroll_delta.delta_y, 640);
  assert.equal(result.hit.ref, "e-hit");
}

async function snapshotBoundPointCancellationAfterVisualVerificationSkipsInput() {
  const state = { cancelled: false };
  let inputDispatches = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsInput: {
      async perform(_tabId, _action, details) {
        state.cancelled = true;
        details.beforeDispatch();
        inputDispatches += 1;
      },
      async performWithSend() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("point_action", {
      tabId: 7, action: "click", normalizedX: 0.5, normalizedY: 0.25,
      expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
      expectedScreenshotSha256: "a".repeat(64), screenshotFormat: "png", screenshotQuality: 90,
    }, state),
    /browser request cancelled/,
  );
  assert.equal(inputDispatches, 0,
    "visual point action started trusted Input after cancellation arrived during visual revalidation");
}

async function pointActionPreservesSettlementWhenTabMetadataReadFails() {
  let tabReads = 0;
  let dispatches = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    getTab(tab) {
      tabReads += 1;
      if (tabReads <= 2) return { ...tab };
      throw new Error("post-point-action tab metadata unavailable");
    },
    devtoolsInput: {
      async perform() { dispatches += 1; },
      async performWithSend() {},
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("point_action", {
    tabId: 7, action: "click", normalizedX: 0.5, normalizedY: 0.25,
    expectedDocumentEpoch: "doc-stable", expectedViewport: { width: 800, height: 600, scale: 1 },
    expectedScreenshotSha256: "a".repeat(64), screenshotFormat: "png", screenshotQuality: 90,
  }, {});
  assert.equal(dispatches, 1, "trusted point action was replayed after post-action tab metadata became unavailable");
  assert.equal(result.tab_id, 7);
  assert.equal(result.tab_metadata_verified, false);
  assert.equal(Object.hasOwn(result, "title"), false);
  assert.equal(Object.hasOwn(result, "url"), false);
}

async function backendNodeRejectsCoercibleAuthorityBeforeInput() {
  let sessionUsed = false;
  let inputUsed = false;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: { async run() { sessionUsed = true; } },
    devtoolsInput: {
      async performWithSend() { inputUsed = true; },
      async perform() { inputUsed = true; },
    },
  });
  for (const params of [
    { tabId: 7, action: "click", backendNodeId: "42", extensionFrameId: 0, expectedDocumentEpoch: "doc-stable" },
    { tabId: 7, action: "click", backendNodeId: [42], extensionFrameId: 0, expectedDocumentEpoch: "doc-stable" },
    { tabId: 7, action: "click", backendNodeId: 42, extensionFrameId: "0", expectedDocumentEpoch: "doc-stable", expectedFrameDocumentEpoch: "doc-stable" },
    { tabId: 7, action: "click", backendNodeId: 42, extensionFrameId: 0, expectedDocumentEpoch: "doc-stable", expectedFrameDocumentEpoch: ["doc-stable"] },
  ]) {
    await assert.rejects(
      () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", params, {}),
      /(valid backend node|snapshot_backend_target_changed_before_dispatch|snapshot authority string is invalid)/,
    );
  }
  assert.equal(sessionUsed, false, "coercible backend authority opened a DevTools session");
  assert.equal(inputUsed, false, "coercible backend authority reached trusted input");
}

async function malformedCdpTrustedEvidenceCannotReachInput() {
  const inputCalls = [];
  let mode = "quad";
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          if (method === "DOM.getContentQuads") {
            if (mode === "quad") return { quads: [["100", 100, 200, 100, 200, 140, 100, 140]] };
            return { quads: [[100, 100, 200, 100, 200, 140, 100, 140]] };
          }
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          if (method === "Accessibility.getPartialAXTree") return { nodes: [{
            backendDOMNodeId: [params.backendNodeId],
            properties: [{ name: "checked", value: { type: "tristate", value: ["false"] } }],
          }] };
          if (method === "DOM.focus") return {};
          throw new Error(`unexpected malformed CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() { inputCalls.push({ action: "perform" }); },
    },
  });
  await assert.rejects(() => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "click", backendNodeId: 42, extensionFrameId: 0, expectedDocumentEpoch: "doc-stable",
  }, {}), /snapshot_backend_geometry_unavailable_before_dispatch/);
  assert.equal(inputCalls.length, 0, "coercible CDP content quad reached trusted input");
  mode = "checked";
  await assert.rejects(() => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "check", backendNodeId: 42, extensionFrameId: 0, expectedDocumentEpoch: "doc-stable",
  }, {}), /snapshot_backend_checked_state_unavailable_before_dispatch/);
  assert.equal(inputCalls.length, 0, "coercible CDP checked-state identity/value reached trusted input");
}

async function backendNodeActionUsesViewportQuadAcrossFrames() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(tabId, operation) {
        assert.equal(tabId, 7);
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.scrollIntoViewIfNeeded") return {};
          if (method === "DOM.getContentQuads") return { quads: [[100, 100, 200, 100, 200, 140, 100, 140]] };
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          throw new Error(`unexpected backend action CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "click", backendNodeId: 42, extensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
  }, {});
  assert.equal(result.coordinate_source, "cdp_content_quad");
  assert.equal(result.cross_frame_trusted, true);
  assert.equal(result.tab_metadata_verified, true);
  assert.equal(result.point.x, 150);
  assert.equal(result.point.y, 120);
  assert.equal(inputCalls[0].action, "click");
  assert.equal(inputCalls[0].details.point.x, 150);
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.getContentQuads", "Page.getLayoutMetrics"],
    "in-viewport backend pointer action performed a side-effecting scroll before read-only geometry preflight");
}

async function backendNodeDragRevalidatesBothEndpoints() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(tabId, operation) {
        assert.equal(tabId, 7);
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") {
            if (params.backendNodeId === 42) return { quads: [[100, 100, 200, 100, 200, 140, 100, 140]] };
            if (params.backendNodeId === 77) return { quads: [[500, 300, 600, 300, 600, 360, 500, 360]] };
          }
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          throw new Error(`unexpected backend drag CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "drag", backendNodeId: 42, destinationBackendNodeId: 77,
    extensionFrameId: 0, destinationExtensionFrameId: 0, expectedDocumentEpoch: "doc-stable",
  }, {});
  assert.equal(inputCalls.length, 1);
  assert.equal(inputCalls[0].action, "drag");
  assert.equal(inputCalls[0].details.point.x, 150);
  assert.equal(inputCalls[0].details.point.y, 120);
  assert.equal(inputCalls[0].details.destinationPoint.x, 550);
  assert.equal(inputCalls[0].details.destinationPoint.y, 330);
  assert.equal(result.point.x, 150);
  assert.equal(result.destination_point.x, 550);
  assert.deepEqual(cdpCalls.map((entry) => entry.method), [
    "DOM.getContentQuads", "Page.getLayoutMetrics", "DOM.getContentQuads", "Page.getLayoutMetrics",
  ], "backend drag introduced scroll or mutation before both endpoint geometries were proven in-viewport");
}

async function backendNodeDragRejectsStaleDestinationBeforeInput() {
  let inputDispatches = 0;
  let debuggerSessions = 0;
  const frameFixtures = [{
    frameId: 5,
    url: "https://child.example/destination",
    inspect: { document: { epoch: "doc-destination-new", url: "https://child.example/destination" }, elements: [], truncated: false },
  }];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    frameFixtures,
    devtoolsSession: {
      async run(_tabId, operation) {
        debuggerSessions += 1;
        return operation({ send: async () => ({}) });
      },
    },
    devtoolsInput: {
      async performWithSend() { inputDispatches += 1; },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "drag", backendNodeId: 42, destinationBackendNodeId: 77,
      extensionFrameId: 0, destinationExtensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
      destinationExpectedFrameDocumentEpoch: "doc-destination-old",
      destinationExpectedFrameUrl: "https://child.example/destination",
    }, {}),
    /snapshot_backend_target_changed_before_dispatch/,
  );
  assert.equal(debuggerSessions, 0, "stale drag destination attached the debugger before rejecting the snapshot");
  assert.equal(inputDispatches, 0, "stale drag destination reached trusted Input");
}

async function backendNodeScrollUsesVisibleSnapshotAnchor() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(tabId, operation) {
        assert.equal(tabId, 7);
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") return { quads: [[240, 180, 440, 180, 440, 380, 240, 380]] };
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          throw new Error(`unexpected backend scroll CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "scroll", backendNodeId: 42, extensionFrameId: 0, expectedDocumentEpoch: "doc-stable",
    deltaX: 0, deltaY: 720,
  }, {});
  assert.equal(inputCalls.length, 1, "backend scroll dispatched more than one trusted input operation");
  assert.equal(inputCalls[0].action, "scroll");
  assert.equal(inputCalls[0].details.point.x, 340);
  assert.equal(inputCalls[0].details.point.y, 280);
  assert.equal(inputCalls[0].details.deltaX, 0);
  assert.equal(inputCalls[0].details.deltaY, 720);
  assert.equal(result.scroll_delta.delta_x, 0);
  assert.equal(result.scroll_delta.delta_y, 720);
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.getContentQuads", "Page.getLayoutMetrics"],
    "backend scroll performed a hidden positioning mutation before the business wheel event");
}

async function backendNodeScrollRejectsOffscreenAnchorWithoutAutoScroll() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") return { quads: [[900, 100, 1000, 100, 1000, 140, 900, 140]] };
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("snapshot-bound scroll must not auto-scroll its anchor");
          throw new Error(`unexpected offscreen-scroll CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "scroll", backendNodeId: 42, extensionFrameId: 0, expectedDocumentEpoch: "doc-stable",
      deltaX: 0, deltaY: 500,
    }, {}),
    /snapshot_backend_scroll_geometry_unavailable_before_dispatch/,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.getContentQuads", "Page.getLayoutMetrics"],
    "offscreen scroll anchor triggered scrollIntoView before rejection");
  assert.equal(inputCalls.length, 0, "offscreen scroll anchor reached trusted wheel Input");
}

async function backendNodeQueuedCancellationSkipsDebuggerAttach() {
  const state = { cancelled: false };
  let debuggerAttaches = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation, options = {}) {
        state.cancelled = true;
        options.beforeAttach?.();
        debuggerAttaches += 1;
        return operation({ send: async () => ({}) });
      },
    },
    devtoolsInput: { async performWithSend() { throw new Error("cancelled backend session must not dispatch input"); }, async perform() {} },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "click", backendNodeId: 46, extensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
    }, state),
    /browser request cancelled/,
  );
  assert.equal(debuggerAttaches, 0,
    "backend action attached the debugger after cancellation arrived while its trusted session was queued");
}

async function backendNodeMissingViewportMetricsDoesNotScroll() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") return { quads: [[900, 100, 1000, 100, 1000, 140, 900, 140]] };
          if (method === "Page.getLayoutMetrics") throw new Error("layout metrics unavailable");
          if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("must not scroll without viewport evidence");
          throw new Error(`unexpected viewport-metrics CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "click", backendNodeId: 44, extensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
    }, {}),
    /snapshot_backend_geometry_unavailable_before_dispatch/,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.getContentQuads", "Page.getLayoutMetrics"],
    "missing viewport metrics were misclassified as an off-screen target and triggered a side-effecting scroll");
  assert.equal(inputCalls.length, 0, "missing viewport metrics reached trusted pointer Input");
}

async function backendNodePointerScrollMakesLaterFailureUnknown() {
  const inputCalls = [];
  const cdpCalls = [];
  let quadReads = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") {
            quadReads += 1;
            if (quadReads === 1) return { quads: [[900, 100, 1000, 100, 1000, 140, 900, 140]] };
            throw new Error("layout vanished after scroll");
          }
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          if (method === "DOM.scrollIntoViewIfNeeded") return {};
          throw new Error(`unexpected pointer-scroll CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "click", backendNodeId: 43, extensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
    }, {}),
    /trusted browser input may have been partially dispatched.*outcome is unknown/i,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), [
    "DOM.getContentQuads", "Page.getLayoutMetrics", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads",
  ]);
  assert.equal(inputCalls.length, 0, "post-scroll geometry failure reached trusted pointer Input");
}

async function backendNodeCancellationDuringGeometrySkipsScroll() {
  const state = { cancelled: false };
  const cdpCalls = [];
  const inputCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.getContentQuads") return { quads: [[900, 100, 1000, 100, 1000, 140, 900, 140]] };
          if (method === "Page.getLayoutMetrics") {
            state.cancelled = true;
            return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
          }
          if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("cancelled geometry preflight must not scroll");
          throw new Error(`unexpected cancellation geometry CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "click", backendNodeId: 45, extensionFrameId: 5, expectedDocumentEpoch: "doc-stable",
    }, state),
    /browser request cancelled/,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.getContentQuads", "Page.getLayoutMetrics"],
    "backend pointer action started scrolling after cancellation arrived during geometry preflight");
  assert.equal(inputCalls.length, 0, "cancelled backend geometry preflight reached trusted pointer input");
}

async function backendNodeFillUsesDomFocusAcrossFrames() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(tabId, operation) {
        assert.equal(tabId, 7);
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.focus") return {};
          throw new Error(`unexpected text action CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  const result = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7,
    action: "fill",
    backendNodeId: 52,
    extensionFrameId: 9,
    expectedDocumentEpoch: "doc-stable",
    value: "cross-frame text",
  }, {});
  assert.equal(result.coordinate_source, "cdp_dom_focus");
  assert.equal(result.cross_frame_trusted, true);
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["DOM.focus"],
    "focus-based trusted action performed a redundant side-effecting scroll before DOM.focus");
  assert.equal(inputCalls.length, 1, "cross-frame fill was split across multiple trusted dispatch scopes");
  assert.equal(inputCalls[0].action, "fill_text");
  assert.equal(inputCalls[0].details.text, "cross-frame text");
  assert.equal(inputCalls[0].details.selectAllKey, "Control+A");
  assert.equal(cdpCalls.some((entry) => entry.method === "DOM.getContentQuads"), false, "text entry unnecessarily depended on iframe geometry");
}

async function backendNodeToggleAndSubmitUseFocusedTrustedKeys() {
  const inputCalls = [];
  const cdpCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.focus") return {};
          if (method === "Accessibility.getPartialAXTree") {
            const checked = false;
            return { nodes: [{
              backendDOMNodeId: Number(params.backendNodeId),
              properties: [{ name: "checked", value: { type: "tristate", value: checked ? "true" : "false" } }],
            }] };
          }
          throw new Error(`unexpected focused action CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  const checked = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "check", backendNodeId: 62, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
  }, {});
  const alreadyUnchecked = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "uncheck", backendNodeId: 64, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
  }, {});
  const submitted = await context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
    tabId: 7, action: "submit", backendNodeId: 63, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
  }, {});
  assert.equal(checked.coordinate_source, "cdp_dom_focus");
  assert.equal(checked.no_input_required, false);
  assert.equal(alreadyUnchecked.coordinate_source, "cdp_ax_state_noop");
  assert.equal(alreadyUnchecked.no_input_required, true, "last-hop unchecked state did not suppress the trusted Space key");
  assert.equal(submitted.coordinate_source, "cdp_dom_focus");
  assert.deepEqual(inputCalls.map((entry) => [entry.action, entry.details.key]), [["press", "Space"], ["press", "Enter"]]);
  assert.equal(cdpCalls.filter((entry) => entry.method === "Accessibility.getPartialAXTree").length, 3,
    "desired-state backend actions did not perform the pre-focus no-op read plus last-hop recheck");
  assert.equal(cdpCalls.some((entry) => entry.method === "DOM.focus" && Number(entry.params.backendNodeId) === 64), false,
    "already-satisfied browser uncheck still changed focus before returning its no-op result");
}

async function backendNodeCancellationDuringInitialToggleReadSkipsFocus() {
  const state = { cancelled: false };
  const cdpCalls = [];
  const inputCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "Accessibility.getPartialAXTree") {
            state.cancelled = true;
            return { nodes: [{
              backendDOMNodeId: Number(params.backendNodeId),
              properties: [{ name: "checked", value: { type: "tristate", value: "false" } }],
            }] };
          }
          if (method === "DOM.focus") throw new Error("cancelled toggle preflight must not focus");
          throw new Error(`unexpected initial-toggle cancellation CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "check", backendNodeId: 67, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
    }, state),
    /browser request cancelled/,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), ["Accessibility.getPartialAXTree"],
    "backend toggle started DOM.focus after cancellation arrived during the initial checked-state read");
  assert.equal(inputCalls.length, 0, "cancelled initial backend toggle read reached trusted keyboard input");
}

async function backendNodeCancellationDuringPostFocusToggleReadSkipsInput() {
  const state = { cancelled: false };
  const cdpCalls = [];
  const inputCalls = [];
  let checkedReads = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          cdpCalls.push({ method, params });
          if (method === "Accessibility.getPartialAXTree") {
            checkedReads += 1;
            if (checkedReads === 2) state.cancelled = true;
            return { nodes: [{
              backendDOMNodeId: Number(params.backendNodeId),
              properties: [{ name: "checked", value: { type: "tristate", value: "false" } }],
            }] };
          }
          if (method === "DOM.focus") return {};
          throw new Error(`unexpected post-focus cancellation CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "check", backendNodeId: 68, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
    }, state),
    /trusted browser input may have been partially dispatched.*outcome is unknown/i,
  );
  assert.deepEqual(cdpCalls.map((entry) => entry.method), [
    "Accessibility.getPartialAXTree", "DOM.focus", "Accessibility.getPartialAXTree",
  ], "post-focus toggle cancellation did not stop at the checked-state read boundary");
  assert.equal(inputCalls.length, 0, "post-focus toggle cancellation still dispatched the Space key");
}

async function backendNodeToggleTreatsPostFocusStateFailureAsUnknown() {
  const inputCalls = [];
  let checkedReads = 0;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method, params = {}) => {
          if (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.focus") return {};
          if (method === "Accessibility.getPartialAXTree") {
            checkedReads += 1;
            return { nodes: [{
              backendDOMNodeId: Number(params.backendNodeId),
              properties: [{ name: "checked", value: { type: "tristate", value: checkedReads === 1 ? "false" : "mixed" } }],
            }] };
          }
          throw new Error(`unexpected checked-state CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "check", backendNodeId: 65, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
    }, {}),
    /trusted browser input may have been partially dispatched.*outcome is unknown/i,
  );
  assert.equal(checkedReads, 2, "post-focus checked-state failure did not happen after a successful pre-focus state read");
  assert.equal(inputCalls.length, 0, "indeterminate post-focus checked state reached trusted keyboard input");
}

async function backendNodeFocusFailureIsUnknownWithoutFallback() {
  const inputCalls = [];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    devtoolsSession: {
      async run(_tabId, operation) {
        return operation({ send: async (method) => {
          if (method === "DOM.scrollIntoViewIfNeeded") return {};
          if (method === "DOM.focus") throw new Error("focus transport timed out");
          throw new Error(`unexpected focus-failure CDP command ${method}`);
        } });
      },
    },
    devtoolsInput: {
      async performWithSend(_send, action, details) { inputCalls.push({ action, details }); },
      async perform() {},
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "submit", backendNodeId: 66, extensionFrameId: 4, expectedDocumentEpoch: "doc-stable",
    }, {}),
    /trusted browser input may have been partially dispatched.*outcome is unknown/i,
  );
  assert.equal(inputCalls.length, 0, "ambiguous DOM.focus failure reached a later trusted key dispatch");
}

async function backendNodeResourceValueResolvesOnlyInDaemonService() {
  const requested = [];
  const resources = [];
  const binaryResources = [];
  const service = new BrowserOperationService({
    authorizeTool() {},
    async ensureStarted() {},
    async request(method, params) { requested.push({ method, params }); return { ok: true, input_mode: "trusted" }; },
    bridgeStatus() { return { extensionInfo: { capabilities: ["backend_node_trusted_input"] } }; },
    extensionPath: "/fixture/extension",
    expectedExtensionVersion: "fixture",
    expectedExtensionId: "fixture",
    async runProcess() { return { code: 0, stdout: "", stderr: "" }; },
    async readResourceText(name) { resources.push(name); return "daemon-only-secret"; },
    readResourceBinary(name) {
      binaryResources.push(name);
      return { buffer: Buffer.from("fixture"), path: `/fixture/${name}.txt`, size: 7 };
    },
  });
  await service.backendNodeAction({
    tab_id: 7,
    action: "fill",
    backend_node_id: 52,
    extension_frame_id: 9,
    document_epoch: "doc-stable",
    frame_document_epoch: "doc-child-stable",
    frame_url: "https://child.example/frame",
    extension_ref: "e-secret",
    expected_ref_identity: { tag: "input", type: "password", role: "textbox", name: "Password", sensitive: true },
    value_resource: "login-password",
  });
  assert.deepEqual(resources, ["login-password"]);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].method, "backend_node_action");
  assert.equal(requested[0].params.value, "daemon-only-secret");
  assert.equal(requested[0].params.expectedFrameDocumentEpoch, "doc-child-stable");
  assert.equal(requested[0].params.expectedFrameUrl, "https://child.example/frame");
  assert.equal(requested[0].params.extensionRef, "e-secret");
  assert.deepEqual(requested[0].params.expectedIdentity,
    { tag: "input", type: "password", role: "textbox", name: "Password", sensitive: true });
  assert.equal(Object.hasOwn(requested[0].params, "value_resource"), false, "resource alias crossed the daemon/extension backend action boundary");
  const textReadsAfterSuccess = resources.length;
  await assert.rejects(
    () => service.backendNodeAction({
      tab_id: 7, action: ["fill"], backend_node_id: 52, value_resource: "login-password",
    }),
    /snapshot backend action must be/,
  );
  await assert.rejects(
    () => service.backendNodeAction({
      tab_id: 7, action: "fill", backend_node_id: 52, value_resource: ["login-password"],
    }),
    /value_resource is invalid/,
  );
  assert.equal(resources.length, textReadsAfterSuccess, "malformed backend action/resource metadata triggered a secret resource read");
  await assert.rejects(
    () => service.fillForm({
      fields: [
        { selector: { id: "first" }, action: "fill", value_resource: "login-password" },
        { selector: { id: "second" }, action: ["fill"], value: "x" },
      ],
    }),
    /unsupported form field action/,
  );
  await assert.rejects(
    () => service.fillForm({
      fields: [{ selector: { id: "first" }, action: "fill", value_resource: "login-password" }],
      wait_for: ["complete"],
    }),
    /wait_for must be none, domcontentloaded, or complete/,
  );
  assert.equal(resources.length, textReadsAfterSuccess, "malformed form metadata triggered a secret resource read before full preflight");
  await assert.rejects(
    () => service.uploadFiles({ selector: { id: ["file"] }, resources: ["upload-secret"] }),
    /selector.id must be a string/,
  );
  await assert.rejects(
    () => service.uploadFiles({ selector: { id: "file" }, resources: ["upload-secret"], timeout_seconds: "60" }),
    /expected an integer/,
  );
  assert.equal(binaryResources.length, 0, "malformed upload metadata triggered a binary resource read before full preflight");
  await assert.rejects(() => service.screenshot({ tab_id: 7, format: ["png"] }), /format must be png or jpeg/);
  await assert.rejects(
    () => service.backendNodeAction({
      tab_id: 7, action: "fill", backend_node_id: 52,
      value: "public", value_resource: "login-password",
    }),
    /mutually exclusive/,
  );
  await assert.rejects(
    () => service.act({ action: "fill", selector: { id: "field" }, value: ["coercible"] }),
    /value must be a string/,
  );
  await assert.rejects(
    () => service.act({ action: "fill", selector: { id: "field" }, value_resource: ["login-password"] }),
    /value_resource is invalid/,
  );
  assert.equal(resources.length, textReadsAfterSuccess, "malformed direct browser action triggered a secret resource read");
  for (const action of ["click", "double_click", "hover", "check", "uncheck", "focus", "press", "submit", "scroll_into_view", "reload", "back", "forward"]) {
    await assert.rejects(
      () => service.act({ action, ...(action === "click" ? { selector: { id: "field" } } : {}), value_resource: "login-password" }),
      /value and value_resource are not valid/,
    );
  }
  assert.equal(resources.length, textReadsAfterSuccess, "non-value browser action read a secret resource before action-specific rejection");
  await service.act({
    tab_id: 7,
    action: "click",
    selector: { ref: "e-save" },
    expected_ref_identity: { tag: "button", role: "button", name: "Save", id: "save", sensitive: false },
    wait_for: "none",
    input_mode: "auto",
  });
  assert.equal(requested[1].method, "action");
  assert.deepEqual(requested[1].params.expectedIdentity,
    { tag: "button", role: "button", name: "Save", id: "save", sensitive: false },
  "legacy browser action service dropped or rewrote the private snapshot identity");
  await service.act({
    tab_id: 7, action: "reload", expected_tab_url: "https://example.test/history",
    expected_document_epoch: "doc-history-stable", expected_history_entry_key: "history-slot-stable",
    wait_for: "none", input_mode: "auto",
  });
  assert.equal(requested[2].method, "action");
  assert.equal(requested[2].params.expectedTabUrl, "https://example.test/history",
    "snapshot-bound navigation action dropped the private expected tab URL before the extension boundary");
  assert.equal(requested[2].params.expectedDocumentEpoch, "doc-history-stable",
    "snapshot-bound history action dropped the private expected document epoch before the extension boundary");
  assert.equal(requested[2].params.expectedHistoryEntryKey, "history-slot-stable",
    "snapshot-bound history action dropped the private expected history-entry key before the extension boundary");
  await assert.rejects(
    () => service.act({
      tab_id: 7, action: "navigate", url: "https://example.test/next", expected_document_epoch: "doc-history-stable",
    }),
    /expected_document_epoch is only valid for snapshot-bound reload, back, or forward/,
  );
}

async function backendNodeEpochDriftFailsBeforeInput() {
  let sessionUsed = false;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    documentState: () => ({
      epoch: "doc-new", url: "https://example.test/", ready_state: "complete",
      viewport: { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
    }),
    devtoolsSession: { async run() { sessionUsed = true; } },
    devtoolsInput: { async performWithSend() { throw new Error("must not dispatch"); }, async perform() {} },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7, action: "click", backendNodeId: 42, extensionFrameId: 5, expectedDocumentEpoch: "doc-old",
    }, {}),
    /snapshot_backend_target_changed_before_dispatch/,
  );
  assert.equal(sessionUsed, false, "backend trusted action opened a DevTools session after document epoch drift");
}

async function backendNodeChildFrameEpochDriftFailsBeforeInput() {
  let sessionUsed = false;
  let inputUsed = false;
  const frameFixtures = [{
    frameId: 5,
    url: "https://child.example/frame",
    inspect: {
      snapshot_version: 3,
      document: { epoch: "child-old", url: "https://child.example/frame" },
      elements: [],
      truncated: false,
    },
  }];
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    frameFixtures,
    frameDocumentState(frame) {
      return { epoch: frame.frameId === 5 ? "child-new" : frame.inspect.document.epoch, url: frame.url, ready_state: "complete" };
    },
    devtoolsSession: { async run() { sessionUsed = true; } },
    devtoolsInput: {
      async performWithSend() { inputUsed = true; },
      async perform() { inputUsed = true; },
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7,
      action: "click",
      backendNodeId: 42,
      extensionFrameId: 5,
      expectedDocumentEpoch: "doc-stable",
      expectedFrameDocumentEpoch: "child-old",
      expectedFrameUrl: "https://child.example/frame",
    }, {}),
    /snapshot_backend_target_changed_before_dispatch/,
  );
  assert.equal(sessionUsed, false, "same-URL child-frame reload opened a DevTools input session through an old fused binding");
  assert.equal(inputUsed, false, "same-URL child-frame reload reached trusted input");
}

async function backendNodeRefIdentityDriftFailsBeforeInput() {
  let sessionUsed = false;
  let inputUsed = false;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    refIdentityResult: { attached: true, matched: false },
    devtoolsSession: { async run() { sessionUsed = true; } },
    devtoolsInput: {
      async performWithSend() { inputUsed = true; },
      async perform() { inputUsed = true; },
    },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("backend_node_action", {
      tabId: 7,
      action: "click",
      backendNodeId: 42,
      extensionFrameId: 0,
      extensionRef: "e-save",
      expectedDocumentEpoch: "doc-stable",
      expectedFrameDocumentEpoch: "doc-stable",
      expectedFrameUrl: "https://example.test/",
      expectedIdentity: { role: "button", name: "Save", id: "save" },
    }, {}),
    /snapshot_backend_target_changed_before_dispatch/,
  );
  assert.equal(sessionUsed, false, "repurposed same-document ref opened a DevTools input session");
  assert.equal(inputUsed, false, "repurposed same-document ref reached trusted input");
}

async function stalePointEpochFailsBeforeTrustedInput() {
  let dispatched = false;
  const context = createContext({ async capture() { throw new Error("unused"); } }, {
    documentState: () => ({
      epoch: "doc-new", url: "https://example.test/", ready_state: "complete",
      viewport: { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
    }),
    devtoolsInput: { async perform() { dispatched = true; } },
  });
  await assert.rejects(
    () => context.__machineBridgeBrowserOperations.dispatch("point_action", {
      tabId: 7, action: "click", normalizedX: 0.5, normalizedY: 0.5,
      expectedDocumentEpoch: "doc-old", expectedViewport: { width: 800, height: 600, scale: 1 },
      expectedScreenshotSha256: "a".repeat(64), screenshotFormat: "png", screenshotQuality: 90,
    }, {}),
    /snapshot is stale/,
  );
  assert.equal(dispatched, false, "stale visual point reached trusted input");
}

function createContext(devtoolsObservation, overrides = {}) {
  const tab = { id: 7, windowId: 1, active: true, title: "Fixture", url: "https://example.test/", status: "complete" };
  const documentState = overrides.documentState || (() => ({
    epoch: "doc-stable", url: tab.url, ready_state: "complete", _machine_history_entry_key: "history-stable",
    viewport: { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
  }));
  const frameFixtures = Array.isArray(overrides.frameFixtures) ? overrides.frameFixtures : null;
  const scripting = {
    async executeScript(options) {
      if (options.files) return [];
      if (options.target?.allFrames) {
        if (options.args?.[0] === "documentState") {
          if (frameFixtures) {
            return frameFixtures.map((frame) => ({
              frameId: frame.frameId,
              result: overrides.frameDocumentState
                ? overrides.frameDocumentState(frame)
                : {
                    epoch: String(frame.inspect?.document?.epoch || ""),
                    url: String(frame.inspect?.document?.url || frame.url || ""),
                    ready_state: "complete",
                  },
            }));
          }
          return [{ frameId: 0, result: documentState() }];
        }
        if (frameFixtures) return frameFixtures.map((frame) => ({ frameId: frame.frameId, result: { url: frame.url } }));
        return [{ frameId: 0, result: { url: tab.url } }];
      }
      const operation = options.args?.[0];
      if (operation === "documentState" && Array.isArray(options.target?.frameIds) && options.target.frameIds.length > 1) {
        return options.target.frameIds.map((frameId) => {
          const fixture = frameFixtures?.find((frame) => frame.frameId === frameId);
          return {
            frameId,
            result: fixture
              ? overrides.frameDocumentState
                ? overrides.frameDocumentState(fixture)
                : {
                    epoch: String(fixture.inspect?.document?.epoch || ""),
                    url: String(fixture.inspect?.document?.url || fixture.url || ""),
                    ready_state: "complete",
                  }
              : documentState(),
          };
        });
      }
      if (operation === "inspect") {
        const requestedFrameId = options.target?.frameIds?.[0] ?? 0;
        const fixture = frameFixtures?.find((frame) => frame.frameId === requestedFrameId);
        if (fixture?.inspect) return [{ frameId: requestedFrameId, result: structuredClone(fixture.inspect) }];
        const privateHistory = options.args?.[1]?.includePrivateHistory === true
          ? { _machine_history_entry_key: String(documentState()._machine_history_entry_key || "") }
          : {};
        return [{ frameId: 0, result: {
          snapshot_version: 3,
          document: { epoch: "doc-stable", url: tab.url, title: tab.title, ready_state: "complete", ...privateHistory },
          elements: [{
            ref: "e-save", role: "button", name: "Save", visible: true, enabled: true,
            bounding_box: { x: 10, y: 20, width: 100, height: 30 },
          }],
          truncated: false,
        } }];
      }
      if (operation === "documentState") {
        const requestedFrameId = options.target?.frameIds?.[0] ?? 0;
        const fixture = frameFixtures?.find((frame) => frame.frameId === requestedFrameId);
        const result = fixture
          ? overrides.frameDocumentState
            ? overrides.frameDocumentState(fixture)
            : {
                epoch: String(fixture.inspect?.document?.epoch || ""),
                url: String(fixture.inspect?.document?.url || fixture.url || ""),
                ready_state: "complete",
              }
          : documentState();
        return [{ frameId: requestedFrameId, result }];
      }
      if (operation === "refIdentity") {
        const requestedFrameId = options.target?.frameIds?.[0] ?? 0;
        return [{ frameId: requestedFrameId, result: overrides.refIdentityResult || { attached: true, matched: true } }];
      }
      if (operation === "pointProbe") return [{ frameId: 0, result: { point: options.args?.[1], hit: { ref: "e-hit", tag: "canvas", role: "", name: "", sensitive: false } } }];
      throw new Error(`unexpected page operation ${operation}`);
    },
  };
  const tabs = {
    async get() { return overrides.getTab ? overrides.getTab(tab) : { ...tab }; },
    async query(query) { return overrides.queryTabs ? overrides.queryTabs(query, tab) : [{ ...tab }]; },
    async update() { return { ...tab }; },
    async captureVisibleTab(windowId, options) {
      return overrides.captureVisibleTab ? overrides.captureVisibleTab(windowId, options) : "data:image/png;base64,RkFMTEJBQ0s=";
    },
    onUpdated: listener(),
    onRemoved: listener(),
  };
  const context = vm.createContext({
    chrome: { tabs, scripting, windows: { async update() {} } },
    __machineBridgeDevtoolsObservation: devtoolsObservation,
    __machineBridgeDevtoolsSession: overrides.devtoolsSession || null,
    __machineBridgeDevtoolsInput: overrides.devtoolsInput || { async perform() {}, async performWithSend() {} },
    TextEncoder,
    TextDecoder,
    performance,
    URL,
    JSON,
    Promise,
    Math,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context, { filename: "browser-operations.js" });
  return context;
}

function listener() {
  return { addListener() {}, removeListener() {} };
}
