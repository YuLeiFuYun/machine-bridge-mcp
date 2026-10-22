import assert from "node:assert/strict";
import { buildBrowserObservation, buildContinuation, extractBrowserPrivateBindings, observationDiff, projectPostObservation } from "../../../src/local/computer-use-observation.mjs";
import { BridgeError } from "../../../src/local/errors.mjs";
import {
  PNG_A_BASE64, PNG_A_SHA256,
  managerWith, browserStub, browserSnapshot, browserChildFrameSnapshot,
  appStub, appSnapshot,
} from "./common.mjs";

export async function runBrowserComputerUseTests() {
  browserScreenshotFallbackReasonIsProjected();
  coercibleBrowserPrivateAuthorityIsRejected();
  coercibleContinuationEvidenceFailsClosed();
  coercibleCompactObservationCountsDoNotBecomeEvidence();
  await browserObservationReturnsNativeImage();
  await cancelledBrowserObserveDoesNotPublishSnapshot();
  await malformedBrowserObservationAuthorityDoesNotPublishSnapshot();
  await malformedApplicationObservationAuthorityDoesNotPublishSnapshot();
  await malformedApplicationPreflightEvidenceFailsClosed();
  await postObservationCancellationPreservesCompletedDispatch();
  await concurrentComputerActsCannotShareSnapshotAuthority();
  await browserFocusQueryIsForwarded();
  await crossFrameSemanticRefUsesPrivateBackendBinding();
  await mediumConfidenceBackendBindingIsIgnored();
  await crossFrameFillUsesPrivateBackendBinding();
  await crossFrameCheckIsIdempotentAndTrusted();
  await crossFrameCheckNoopStillUsesBackendIdentityGate();
  await crossFrameCheckHandlesLastHopDesiredStateRace();
  await crossFrameSubmitUsesTrustedBackendBinding();
  await backendTrustedUnavailableFallsBackOnlyInAutoMode();
  await quarantinedTrustedBackendFallsBackToDomInAutoMode();
  await backendPostFocusFailureNeverFallsBackInAutoMode();
  await backendPostDispatchWaitFailureNeverFallsBackInAutoMode();
  await domMutationFailureStaysUnknownInComputerUse();
  await browserNavigationMutationFailureStaysUnknownInComputerUse();
  await browserObserveAndVerifiedAction();
  await browserPostObservationCanBeFull();
  await semanticDeltaReportsStableRefChanges();
  await browserContinuationRejectsSemanticIdentityDrift();
  await browserContinuationRejectsSiblingFrameRefCollision();
  await browserContinuationRejectsChildFrameEpochReplacement();
  await browserTargetStateRejectsPostIdentityDrift();
  await browserTargetStateMissingFromTruncatedPostIsInconclusive();
  await browserTargetStateMissingFrameFromTruncatedPostIsInconclusive();
  await missingPostObservationRequiresReobserve();
  await postOnlyBrowserExpectationWithoutPostStateStaysUnknown();
  await mixedBrowserExpectationWithoutPostStateStaysUnknown();
  await explicitSemanticChangeCanConfirmEffect();
  await unobservedExpectedEffectUsesPostSnapshotBeforeRetry();
  await explicitVisualChangeCanConfirmEffect();
  await visualChangeRequiresBaselineScreenshot();
  await autoPostScreenshotSkipsRedundantSemanticImage();
  await autoPostScreenshotCapturesUnknownDispatch();
  await postScreenshotIncludedTracksActualImage();
  await postScreenshotPoliciesAreValidated();
  await staleBrowserSnapshotIsRejectedBeforeDispatch();
  await sameUrlReloadSnapshotIsRejectedBeforeDispatch();
  await targetlessHistoryActionsRequireDocumentPreflight();
  await navigateDoesNotRequireDocumentEpochPreflight();
  await navigationActionMapsLastHopUrlRace();
  await historyActionForwardsEpochAndMapsLastHopStale();
  await historyActionRejectsMissingEntryAuthorityBeforeDispatch();
  await historyActionRejectsChangedEntryBeforeDispatch();
  await historyEntryLastHopSettlementIsSnapshotBound();
  await historyActionMapsLastHopUnavailable();
  await browserRefIdentityDriftMapsToStaleWithoutReplay();
  await visualPointDispatchIsSnapshotBound();
  await visualPointRejectsCoercibleSnapshotAuthority();
  await visualPointDragIsSnapshotBound();
  await visualPointScrollIsSnapshotBound();
  await semanticRefDragUsesBothTrustedBindings();
  await semanticRefScrollUsesTrustedBinding();
  await malformedLowerLayerDispatchEvidenceIsNotCoerced();
  await browserDragRejectsMixedEndpointEvidence();
  await browserDragRejectsUnsafeOptionsBeforeDispatch();
  await browserDragUnknownDispatchIsNotReplayed();
  await browserScrollRejectsUnsafeOptionsBeforeDispatch();
  await browserScrollUnknownDispatchIsNotReplayed();
  await visualPointViewportDriftIsRejected();
  await visualPointScreenshotDriftIsRejectedAsStale();
  await legacySnapshotCannotDispatchVisualPoint();
  await unknownDispatchCanStillBeEffectConfirmed();
  await unverifiedMutationStaysUnknown();
  await semanticMetadataCannotConfirmAnEffect();
  await incompleteSemanticCoverageCannotConfirmPresenceChanges();
}

function browserScreenshotFallbackReasonIsProjected() {
  const observation = buildBrowserObservation({
    tab_id: 7,
    title: "Fixture",
    url: "https://example.test/",
    semantic: {
      tab_id: 7, title: "Fixture", url: "https://example.test/", total_elements: 0,
      selection: { mode: "global_salience", _machine_selection_secret: "selection-private" },
      frames: [{ frame_id: 0, _machine_frame_secret: "frame-private",
        document: { url: "https://example.test/", epoch: "doc-fallback", _machine_history_entry_key: "history-private" },
        elements: [{ ref: "e-private-projection", role: "button", _machine_element_secret: "element-private", backend_dom_node_id: 99 }] }],
    },
    _machine_history_entry_key: "history-private",
    accessibility: { _machine_tree_secret: "tree-private", available: true, nodes: [{
      action_ref: "e-private-projection", action_ref_confidence: "medium", backend_dom_node_id: 99, _machine_node_secret: "node-private",
    }] },
    viewport: { width: 800, height: 600, scale: 1, _machine_viewport_secret: "viewport-private" },
    frame_tree: [{ id: "root", url: "https://example.test/", _machine_frame_tree_secret: "frame-tree-private" }],
    document_epoch: "doc-fallback",
    capture: {
      atomic: false,
      navigation_coherent: true,
      coherence: "stable_extension_document_epoch_without_screenshot",
      semantic_epoch: "doc-fallback",
      cdp: false,
      cdp_components: { semantic: true, _machine_component_secret: "component-private" },
      screenshot_source: "none",
      screenshot_fallback_reason: "visible_tab_fallback_skipped_inactive_target",
    },
  }, { include_screenshot: true });
  assert.equal(observation.capture.screenshot_source, "none");
  assert.equal(observation.capture.screenshot_fallback_reason, "visible_tab_fallback_skipped_inactive_target");
  assert.equal(JSON.stringify(observation).includes("history-private"), false,
    "browser history-entry authority leaked through the public Computer Use observation projection");
  assert.equal(JSON.stringify(observation).includes("_machine_"), false,
    "unknown private browser observation fields leaked through blacklist-style public projection");
  for (const secret of ["selection-private", "frame-private", "element-private", "tree-private", "node-private", "viewport-private", "frame-tree-private", "component-private"]) {
    assert.equal(JSON.stringify(observation).includes(secret), false, `private browser projection value leaked: ${secret}`);
  }
}

function coercibleBrowserPrivateAuthorityIsRejected() {
  const captured = {
    _machine_history_entry_key: "history-1",
    accessibility: { nodes: [{ action_ref: "e0", action_ref_confidence: "high", backend_dom_node_id: 42, frame_id: "cdp-frame-5" }] },
    frame_tree: [{ id: "cdp-frame-5", url: "https://example.test/frame" }],
    semantic: { frames: [{
      frame_id: 5,
      document: { epoch: "doc-1", url: "https://example.test/frame" },
      elements: [{ ref: "e0", _machine_backend_node_id: 42, _machine_cdp_frame_id: "unused-cdp-shadow" }],
    }] },
  };
  const valid = extractBrowserPrivateBindings(captured);
  assert.deepEqual(valid.browser_ref_bindings.get("e0"), {
    backend_node_id: 42,
    extension_frame_id: 5,
    extension_frame_epoch: "doc-1",
    extension_frame_url: "https://example.test/frame",
  });
  assert.equal(valid.browser_history_entry_key, "history-1");
  assert.equal(Object.hasOwn(valid.browser_ref_bindings.get("e0"), "cdp_frame_id"), false,
    "unused CDP frame shadow survived in executable browser snapshot authority");

  for (const mutate of [
    (value) => { value.semantic.frames[0].elements[0]._machine_backend_node_id = "42"; },
    (value) => { value.semantic.frames[0].elements[0]._machine_backend_node_id = [42]; },
    (value) => { value.semantic.frames[0].frame_id = "5"; },
    (value) => { value.semantic.frames[0].document.epoch = ["doc-1"]; },
    (value) => { value.semantic.frames[0].document.url = ["https://example.test/frame"]; },
  ]) {
    const malformed = structuredClone(captured);
    mutate(malformed);
    assert.equal(extractBrowserPrivateBindings(malformed).browser_ref_bindings.size, 0,
      "coercible browser snapshot binding was accepted as executable authority");
  }
  for (const mutate of [
    (value) => { value.accessibility.nodes[0].backend_dom_node_id = 43; },
    (value) => { value.accessibility.nodes[0].backend_dom_node_id = "42"; },
    (value) => { value.accessibility.nodes.push({ action_ref: "e0", action_ref_confidence: "high", backend_dom_node_id: 43, frame_id: "cdp-frame-5" }); },
    (value) => { value.accessibility.nodes[0].action_ref = ["e0"]; },
    (value) => { value.accessibility.nodes[0].frame_id = "cdp-other"; value.frame_tree.push({ id: "cdp-other", url: "https://other.test/" }); },
    (value) => { value.frame_tree[0].url = "https://other.test/"; },
    (value) => { value.semantic.frames.push({ ...structuredClone(value.semantic.frames[0]), frame_id: 6 }); },
  ]) {
    const mismatched = structuredClone(captured);
    mutate(mismatched);
    assert.equal(extractBrowserPrivateBindings(mismatched).browser_ref_bindings.size, 0,
      "mismatched/coercible AX evidence was cross-wired into trusted backend-node authority");
  }
  for (const malformedHistory of [["history-1"], { toString: () => "history-1" }, 7]) {
    const malformed = structuredClone(captured);
    malformed._machine_history_entry_key = malformedHistory;
    assert.equal(extractBrowserPrivateBindings(malformed).browser_history_entry_key, "",
      "coercible browser history entry became snapshot authority");
  }

  const malformedEpochCapture = {
    ...structuredClone(captured),
    tab_id: 7, title: "Fixture", url: "https://example.test/",
    document_epoch: ["doc-1"],
    capture: {
      atomic: false, navigation_coherent: true, frame_epochs_coherent: true,
      semantic_epoch: ["doc-1"], cdp_epoch: ["cdp-doc-1"], cdp: true,
      screenshot_source: "none", screenshot_format: "",
    },
  };
  const projected = buildBrowserObservation(malformedEpochCapture, { include_screenshot: false });
  assert.equal(projected.document_epoch, "", "coercible top-level document epoch became public snapshot authority");
  assert.equal(projected.capture.semantic_epoch, "", "coercible semantic epoch became actionable snapshot authority");
  assert.equal(projected.capture.cdp_epoch, "", "coercible CDP epoch became actionable snapshot authority");
  assert.equal(projected.capabilities.document_epoch_preflight, false,
    "malformed document epoch incorrectly advertised snapshot document preflight");

  const visualBase = {
    ...structuredClone(captured),
    tab_id: 7, title: "Fixture", url: "https://example.test/",
    document_epoch: "doc-visual",
    viewport: { width: 800, height: 600, scale: 1 },
    capture: {
      atomic: false, navigation_coherent: true, frame_epochs_coherent: true,
      semantic_epoch: "doc-visual", cdp_epoch: "cdp-visual", cdp: true,
      screenshot_source: "cdp_surface", screenshot_format: "png", screenshot_quality: 90,
      screenshot_sha256: "a".repeat(64),
    },
  };
  assert.equal(buildBrowserObservation(visualBase, { include_screenshot: true }).capabilities.snapshot_bound_visual_points, true,
    "valid browser visual fixture did not expose snapshot-bound point authority");
  for (const mutate of [
    (value) => { value.capture.screenshot_source = ["cdp_surface"]; },
    (value) => { value.capture.screenshot_sha256 = ["a".repeat(64)]; },
    (value) => { value.viewport.width = [800]; },
    (value) => { value.viewport.scale = "1"; },
  ]) {
    const malformed = structuredClone(visualBase);
    mutate(malformed);
    const observation = buildBrowserObservation(malformed, { include_screenshot: true });
    assert.equal(observation.capabilities.snapshot_bound_visual_points, false,
      "coercible browser capture metadata became visual snapshot authority");
  }
}

function coercibleContinuationEvidenceFailsClosed() {
  const semantic = browserSnapshot("https://example.test/coercible-continuation", "e-coercible", "doc-coercible");
  const raw = {
    tab_id: semantic.tab_id, title: semantic.title, url: semantic.url, semantic: structuredClone(semantic),
    accessibility: null, viewport: null, frame_tree: [], document_epoch: "doc-coercible",
    capture: { semantic_epoch: "doc-coercible", screenshot_source: "none" },
  };
  const before = buildBrowserObservation(raw, { include_screenshot: false });
  const after = structuredClone(before);
  after.capture.semantic_epoch = ["doc-coercible"];
  after.document_epoch = ["doc-coercible"];
  after.semantic.frames[0].document.epoch = ["doc-coercible"];
  after.semantic.frames[0].document.url = ["https://example.test/coercible-continuation"];
  const diff = observationDiff(before, after);
  assert.equal(diff.document_epoch_changed, null, "coercible document epoch was treated as a stable document generation");
  assert.equal(diff.frame_epoch_changed, null, "coercible frame authority was treated as a stable frame generation");
  const target = {
    kind: "ref",
    ref: "e-coercible",
    frame_id: before.semantic.frames[0].frame_id,
    element: before.semantic.frames[0].elements[0],
  };
  const continuation = buildContinuation(before, after, target, diff);
  assert.equal(continuation.document_epoch_same, false);
  assert.equal(continuation.target_frame_epoch_same, false);
  assert.equal(continuation.previous_target_ref_reusable, false,
    "coercible post-observation authority made a prior snapshot ref reusable");
  assert.equal(continuation.reobserve_recommended, true);
}

function coercibleCompactObservationCountsDoNotBecomeEvidence() {
  const compact = projectPostObservation({
    snapshot_id: "cu_compact", surface: "browser", captured_at: "2026-08-13T00:00:00.000Z",
    target: {}, capture: {}, capabilities: {}, document_epoch: "doc-compact",
    semantic: {
      kind: "browser-hybrid", total_elements: "9", max_elements: [300], frames_truncated: false,
      selection: null, viewport: null, accessibility: {
        available: true, returned_nodes: "8", observed_nodes: [9], ignored_nodes: 1.5, truncated: false,
        query_matched: true, query_match_count: [3], query_search_exhaustive: true, top_query_score: "42", failed_frame_count: "1",
      },
    },
  }, "compact");
  assert.equal(compact.semantic.total_elements, 0);
  assert.equal(compact.semantic.max_elements, 0);
  assert.equal(compact.semantic.accessibility.returned_nodes, 0);
  assert.equal(compact.semantic.accessibility.observed_nodes, 0);
  assert.equal(compact.semantic.accessibility.ignored_nodes, 0);
  assert.equal(compact.semantic.accessibility.query_match_count, null);
  assert.equal(compact.semantic.accessibility.top_query_score, null);
  assert.equal(compact.semantic.accessibility.failed_frame_count, 0);
}

async function browserObservationReturnsNativeImage() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/image", "e0")] });
  const manager = managerWith({ browser });
  const result = await manager.observe({ surface: "browser" });
  assert(result.$mcp, "browser observation with screenshot must return native MCP content");
  assert.equal(result.$mcp.content[1].type, "image");
  assert.equal(result.$mcp.content[1].data, PNG_A_BASE64);
  assert.equal(result.$mcp.content[1].mimeType, "image/png");
  assert.match(result.$mcp.structuredContent.snapshot_id, /^cu_/);
  assert.equal(result.$mcp.structuredContent.capture.atomic, false);
}

async function cancelledBrowserObserveDoesNotPublishSnapshot() {
  const calls = [];
  const first = browserSnapshot("https://example.test/cancelled-observe", "e-cancelled", "doc-cancelled");
  const browser = browserStub({ inspectQueue: [first, structuredClone(first)], calls });
  let cancelled = true;
  const manager = managerWith({
    browser,
    throwIfCancelled() {
      if (cancelled && calls.some((entry) => entry.kind === "observe")) {
        throw new BridgeError("cancelled", "computer observation cancelled before snapshot publication");
      }
    },
  });
  await assert.rejects(
    () => manager.observe({ surface: "browser", include_screenshot: false }),
    (error) => error instanceof BridgeError && error.code === "cancelled",
  );
  assert.equal(manager.snapshots.items.size, 0, "cancelled browser observation published an actionable snapshot");
  cancelled = false;
  const recovered = await manager.observe({ surface: "browser", include_screenshot: false });
  assert.equal(recovered.snapshot_id, "cu_test00000001", "cancelled browser observation consumed a snapshot id before publication");
  assert.equal(manager.snapshots.items.size, 1, "successful browser observation did not publish its snapshot after cancellation recovery");
}

async function malformedBrowserObservationAuthorityDoesNotPublishSnapshot() {
  const cases = [
    (value) => { value.tab_id = "7"; },
    (value) => { value.url = [value.url]; },
    (value) => { value.document_epoch = ["doc-malformed"]; },
    (value) => { value.capture = { semantic_epoch: ["doc-malformed"] }; },
    (value) => { value.title = [value.title]; },
    (value) => { value.frames_truncated = "false"; },
    (value) => { delete value.frames_truncated; },
    (value) => { value.frames[0].truncated = "false"; },
    (value) => { delete value.frames[0].truncated; },
  ];
  for (const mutate of cases) {
    const snapshot = browserSnapshot("https://example.test/malformed-observation-authority", "e-malformed", "doc-malformed");
    mutate(snapshot);
    const manager = managerWith({ browser: browserStub({ inspectQueue: [snapshot] }) });
    await assert.rejects(() => manager.observe({ surface: "browser", include_screenshot: false }),
      /browser observation (?:tab id|authority string|string|truncation evidence) is invalid/);
    assert.equal(manager.snapshots.items.size, 0, "malformed browser authority published an actionable Computer Use snapshot");
  }
}

async function malformedApplicationObservationAuthorityDoesNotPublishSnapshot() {
  const cases = [
    (value) => { value.process_name = ["Notes"]; },
    (value) => { value.frontmost = 0; },
    (value) => { value.truncated = "false"; },
    (value) => { value.menus_included = [false]; },
    (value) => { value.elements = { 0: value.elements[0] }; },
    (value) => { value.elements[0] = [value.elements[0]]; },
  ];
  for (const mutate of cases) {
    const snapshot = appSnapshot(false, false);
    mutate(snapshot);
    const manager = managerWith({ applications: appStub({ inspectQueue: [snapshot] }) });
    await assert.rejects(
      () => manager.observe({ surface: "application", application: "Notes", include_screenshot: false }),
      /application observation/,
    );
    assert.equal(manager.snapshots.items.size, 0,
      "malformed application inspection evidence published an actionable Computer Use snapshot");
  }
}

async function malformedApplicationPreflightEvidenceFailsClosed() {
  const before = appSnapshot(false, false);
  const malformed = appSnapshot(false, false);
  malformed.truncated = "false";
  const calls = [];
  const manager = managerWith({ applications: appStub({ inspectQueue: [before, malformed], calls }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
      post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false,
    "malformed application preflight coverage reached Accessibility mutation dispatch");
}

async function postObservationCancellationPreservesCompletedDispatch() {
  const calls = [];
  const before = browserSnapshot("https://example.test/post-cancel", "e-post-cancel", "doc-post-cancel");
  const browser = browserStub({ inspectQueue: [before, structuredClone(before)], calls });
  const manager = managerWith({
    browser,
    throwIfCancelled() {
      if (calls.filter((entry) => entry.kind === "observe").length >= 2) {
        throw new BridgeError("cancelled", "computer post-observation cancelled before snapshot publication at /private/tmp/operator-secret");
      }
    },
  });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "click",
    target: { ref: "e-post-cancel" },
    input_mode: "dom",
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed", "post-observation cancellation overwrote a completed browser dispatch");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.post_snapshot_id, null, "cancelled post-observation published a continuation snapshot");
  assert.equal(acted.post_observation, null);
  assert.match(acted.post_observation_error, /browser post observation unavailable \(error_class=cancelled\)/);
  assert.equal(acted.post_observation_error.includes("/private/tmp/operator-secret"), false,
    "cancelled post-observation leaked lower-layer private error detail");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false,
    "post-observation cancellation incorrectly made the completed action automatically retryable");
  assert.equal(manager.snapshots.items.size, 0, "completed dispatch retained its consumed input snapshot after post-observation cancellation");
}

async function concurrentComputerActsCannotShareSnapshotAuthority() {
  const calls = [];
  const before = browserSnapshot("https://example.test/snapshot-lease", "e-lease", "doc-lease");
  const after = structuredClone(before);
  const browser = browserStub({ inspectQueue: [before, after], calls });
  const ordinaryAct = browser.act.bind(browser);
  let releaseDispatch;
  let markDispatchStarted;
  const dispatchStarted = new Promise((resolve) => { markDispatchStarted = resolve; });
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  browser.act = async (args) => {
    markDispatchStarted();
    await dispatchGate;
    return ordinaryAct(args);
  };
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const first = manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-lease" },
    input_mode: "dom", post_screenshot: "never",
  });
  await dispatchStarted;
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-lease" },
      input_mode: "dom", post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
  releaseDispatch();
  const settled = await first;
  assert.equal(settled.dispatch_status, "completed");
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
    "concurrent Computer Use calls dispatched more than once from one snapshot authority");
  assert.equal(manager.snapshots.items.has(observed.snapshot_id), false,
    "completed Computer Use dispatch restored its one-shot input snapshot authority");
  assert.equal(manager.snapshots.items.has(settled.post_snapshot_id), true,
    "completed Computer Use dispatch did not retain the new continuation snapshot");
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-lease" },
      input_mode: "dom", post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
}

async function browserFocusQueryIsForwarded() {
  const calls = [];
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/focus", "e-focus")], calls });
  const manager = managerWith({ browser });
  await manager.observe({ surface: "browser", focus_query: "Save changes", include_screenshot: false });
  const observedCall = calls.find((entry) => entry.kind === "observe");
  assert.equal(observedCall.args.focus_query, "Save changes");
}

async function crossFrameSemanticRefUsesPrivateBackendBinding() {
  const calls = [];
  const before = browserSnapshot("https://example.test/frame", "e-frame", "doc-frame");
  before.frames[0].frame_id = 5;
  before.frames[0].elements[0]._machine_backend_node_id = 42;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-child";
  const after = structuredClone(before);
  const browser = browserStub({ inspectQueue: [before, after], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  assert.equal(observed.capabilities.fused_accessibility_action_refs, 1,
    "high-confidence fused ref was not counted as an executable Accessibility action ref");
  const publicElement = observed.semantic.frames[0].elements[0];
  assert.equal(Object.hasOwn(publicElement, "_machine_backend_node_id"), false, "Computer Use leaked its private backend-node binding");
  assert.equal(Object.hasOwn(publicElement, "_machine_cdp_frame_id"), false, "Computer Use leaked its private CDP frame binding");
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-frame" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch.coordinate_source, "cdp_content_quad");
  assert.equal(acted.dispatch.cross_frame_trusted, true);
  assert.equal(acted.dispatch.tab_metadata_verified, true);
  const backend = calls.find((entry) => entry.kind === "backend-act");
  assert.equal(backend.args.backend_node_id, 42);
  assert.equal(backend.args.extension_frame_id, 5);
  assert.equal(backend.args.frame_document_epoch, "doc-frame");
  assert.equal(backend.args.frame_url, "https://example.test/frame");
  assert.equal(backend.args.extension_ref, "e-frame");
  assert.equal(backend.args.expected_ref_identity.role, "button");
  assert.equal(backend.args.expected_ref_identity.name, "Continue");
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "bound subframe ref unexpectedly fell back to the DOM ref action path");
}

async function mediumConfidenceBackendBindingIsIgnored() {
  const calls = [];
  const before = browserSnapshot("https://example.test/medium-binding", "e-medium", "doc-medium");
  before.frames[0].elements[0]._machine_backend_node_id = 999;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-medium";
  const after = structuredClone(before);
  const browser = browserStub({ inspectQueue: [before, after], calls, backendBindingConfidence: "medium" });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  assert.equal(observed.capabilities.fused_accessibility_action_refs, 0,
    "medium-confidence correlation inflated the executable fused-ref capability count");
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-medium" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch.tab_metadata_verified, false,
    "browser action without metadata verification evidence was not treated as unverified");
  assert.equal(calls.some((entry) => entry.kind === "backend-act"), false,
    "daemon promoted a medium-confidence AX correlation into snapshot-bound trusted input");
  const domAction = calls.find((entry) => entry.kind === "act");
  assert.equal(Boolean(domAction), true,
    "medium-confidence ref did not fall back to the existing semantic ref action path");
  assert.equal(domAction.args.expected_ref_identity.role, "button");
  assert.equal(domAction.args.expected_ref_identity.name, "Continue");
}

async function crossFrameFillUsesPrivateBackendBinding() {
  const calls = [];
  const before = browserSnapshot("https://example.test/frame-fill", "e-frame-fill", "doc-frame-fill");
  before.frames[0].frame_id = 6;
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0],
    role: "textbox",
    name: "Email",
    editable: true,
    _machine_backend_node_id: 61,
    _machine_cdp_frame_id: "cdp-fill-child",
  };
  const after = structuredClone(before);
  const browser = browserStub({ inspectQueue: [before, after], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "fill",
    target: { ref: "e-frame-fill" },
    value: "person@example.com",
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch.coordinate_source, "cdp_dom_focus");
  assert.equal(acted.dispatch.cross_frame_trusted, true);
  const backend = calls.find((entry) => entry.kind === "backend-act");
  assert.equal(backend.args.backend_node_id, 61);
  assert.equal(backend.args.extension_frame_id, 6);
  assert.equal(backend.args.value, "person@example.com");
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "cross-frame fill unexpectedly used the legacy frame action path");
}

async function crossFrameCheckIsIdempotentAndTrusted() {
  const calls = [];
  const before = browserSnapshot("https://example.test/frame-check", "e-frame-check", "doc-frame-check");
  before.frames[0].frame_id = 4;
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "checkbox", name: "Agree", checked: false,
    _machine_backend_node_id: 71, _machine_cdp_frame_id: "cdp-check-child",
  };
  const after = structuredClone(before);
  after.frames[0].elements[0].checked = true;
  const browser = browserStub({ inspectQueue: [before, after], calls, checkedState: false });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e-frame-check" },
    post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.dispatch.coordinate_source, "cdp_dom_focus");
  assert.equal(calls.filter((entry) => entry.kind === "backend-act").length, 1, "unchecked control was not toggled exactly once");
  assert.equal(calls.some((entry) => entry.kind === "act"), false);

  const noopCalls = [];
  const checked = structuredClone(after);
  const checkedBrowser = browserStub({
    inspectQueue: [checked, structuredClone(checked)], calls: noopCalls, checkedState: true, backendTogglePreFocusNoInput: true,
  });
  const checkedManager = managerWith({ browser: checkedBrowser });
  const checkedObserved = await checkedManager.observe({ surface: "browser", include_screenshot: false });
  const noop = await checkedManager.act({
    surface: "browser", snapshot_id: checkedObserved.snapshot_id, action: "check", target: { ref: "e-frame-check" },
    post_screenshot: "never",
  });
  assert.equal(noop.effect_status, "confirmed");
  assert.equal(noop.dispatch.coordinate_source, "cdp_ax_state_noop");
  assert.equal(noop.dispatch.no_input_required, true);
  assert.equal(noopCalls.filter((entry) => entry.kind === "backend-act").length, 1,
    "already-checked control bypassed the extension identity/frame gate instead of using its mutation-free no-op path");
  assert.equal(noopCalls.some((entry) => entry.kind === "act"), false,
    "already-checked trusted control unexpectedly fell back to the legacy DOM path");
}

async function crossFrameCheckNoopStillUsesBackendIdentityGate() {
  const calls = [];
  const checked = browserSnapshot("https://example.test/frame-check-identity", "e-frame-check-identity", "doc-frame-check-identity");
  checked.frames[0].frame_id = 4;
  checked.frames[0].elements[0] = {
    ...checked.frames[0].elements[0], role: "checkbox", name: "Agree", checked: true,
    _machine_backend_node_id: 73, _machine_cdp_frame_id: "cdp-check-identity-child",
  };
  const browser = browserStub({
    inspectQueue: [checked],
    calls,
    checkedState: true,
    backendNodeActionError: new Error("snapshot backend target changed before trusted input; observe again"),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "check",
      target: { ref: "e-frame-check-identity" }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.filter((entry) => entry.kind === "backend-act").length, 1,
    "desired-state browser no-op did not enter the backend semantic identity gate");
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "stale desired-state browser target fell back to the legacy DOM path");
}

async function crossFrameCheckHandlesLastHopDesiredStateRace() {
  const calls = [];
  const before = browserSnapshot("https://example.test/frame-check-race", "e-frame-check-race", "doc-frame-check-race");
  before.frames[0].frame_id = 4;
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "checkbox", name: "Agree", checked: false,
    _machine_backend_node_id: 72, _machine_cdp_frame_id: "cdp-check-race-child",
  };
  const after = structuredClone(before);
  after.frames[0].elements[0].checked = true;
  const browser = browserStub({
    inspectQueue: [before, after], calls, checkedState: false, backendToggleNoInput: true,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e-frame-check-race" },
    post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.dispatch.coordinate_source, "cdp_dom_focus");
  assert.equal(acted.dispatch.no_input_required, true,
    "extension last-hop desired-state readback was not preserved through Computer Use dispatch sanitization");
  assert.equal(calls.filter((entry) => entry.kind === "backend-act").length, 1,
    "daemon precheck incorrectly replaced the extension last-hop race guard");
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "last-hop desired-state no-op unexpectedly fell back to the DOM action path");
}

async function crossFrameSubmitUsesTrustedBackendBinding() {
  const calls = [];
  const before = browserSnapshot("https://example.test/frame-submit", "e-frame-submit", "doc-frame-submit");
  before.frames[0].frame_id = 8;
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "button", name: "Submit",
    _machine_backend_node_id: 81, _machine_cdp_frame_id: "cdp-submit-child",
  };
  const browser = browserStub({ inspectQueue: [before, structuredClone(before)], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "submit", target: { ref: "e-frame-submit" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch.coordinate_source, "cdp_dom_focus");
  const backend = calls.find((entry) => entry.kind === "backend-act");
  assert.equal(backend.args.action, "submit");
  assert.equal(backend.args.backend_node_id, 81);
  assert.equal(calls.some((entry) => entry.kind === "act"), false);
}

async function backendTrustedUnavailableFallsBackOnlyInAutoMode() {
  const calls = [];
  const autoBefore = browserSnapshot("https://example.test/backend-auto", "e-auto-backend", "doc-auto-backend");
  autoBefore.frames[0].elements[0]._machine_backend_node_id = 77;
  autoBefore.frames[0].elements[0]._machine_cdp_frame_id = "cdp-main";
  const browser = browserStub({
    inspectQueue: [autoBefore, structuredClone(autoBefore)], calls,
    backendNodeActionError: new Error("snapshot backend trusted input unavailable before dispatch"),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-auto-backend" },
    post_screenshot: "never", input_mode: "auto",
  });
  assert.equal(acted.dispatch.input_mode, "trusted", "auto fallback did not reach the existing browser action path");
  assert.equal(calls.some((entry) => entry.kind === "backend-act"), true);
  assert.equal(calls.some((entry) => entry.kind === "act"), true);

  const strictCalls = [];
  const strictBefore = browserSnapshot("https://example.test/backend-strict", "e-strict-backend", "doc-strict-backend");
  strictBefore.frames[0].elements[0]._machine_backend_node_id = 88;
  const strictBrowser = browserStub({
    inspectQueue: [strictBefore], strict: true, calls: strictCalls,
    backendNodeActionError: new Error("snapshot backend trusted input unavailable before dispatch"),
  });
  const strictManager = managerWith({ browser: strictBrowser });
  const strictObserved = await strictManager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => strictManager.act({
      surface: "browser", snapshot_id: strictObserved.snapshot_id, action: "click", target: { ref: "e-strict-backend" },
      post_screenshot: "never", input_mode: "trusted",
    }),
    (error) => error instanceof BridgeError && error.code === "unavailable" && error.details?.reason === "snapshot_backend_trusted_input_unavailable",
  );
  assert.equal(strictCalls.some((entry) => entry.kind === "act"), false, "explicit trusted mode silently fell back after backend geometry became unavailable");
}

async function quarantinedTrustedBackendFallsBackToDomInAutoMode() {
  const calls = [];
  const before = browserSnapshot("https://example.test/backend-quarantined", "e-quarantined-backend", "doc-quarantined-backend");
  before.frames[0].elements[0]._machine_backend_node_id = 91;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-main";
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)],
    calls,
    backendNodeActionError: new BridgeError("unavailable", "trusted browser input is quarantined for the current extension connection after an ambiguous dispatch", {
      retryable: false,
      details: { reason: "browser_trusted_input_quarantined", side_effects_started: false },
    }),
    actResult: { ok: true, tab_id: 41, url: before.url, title: "Example", input_mode: "dom", trusted_input_fallback: true },
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-quarantined-backend" },
    post_screenshot: "never", input_mode: "auto",
  });
  assert.equal(acted.dispatch.input_mode, "dom", "Computer Use did not preserve the daemon-side quarantine fallback transport");
  assert.equal(acted.dispatch.trusted_input_fallback, true, "Computer Use did not expose the trusted-input quarantine fallback");
  assert.equal(calls.filter((entry) => entry.kind === "backend-act").length, 1, "Computer Use retried the quarantined trusted backend");
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1, "Computer Use did not take the single DOM fallback path after definite quarantine preflight");
}

async function backendPostFocusFailureNeverFallsBackInAutoMode() {
  const calls = [];
  const before = browserSnapshot("https://example.test/backend-focus-unknown", "e-focus-unknown", "doc-focus-unknown");
  before.frames[0].elements[0]._machine_backend_node_id = 89;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-main";
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)], calls,
    backendNodeActionError: new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (snapshot_backend_focus_outcome_unknown /private/tmp/operator-secret)"),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "submit", target: { ref: "e-focus-unknown" },
    input_mode: "auto", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.dispatch_error.includes("/private/tmp/operator-secret"), false,
    "unknown Computer Use dispatch leaked lower-layer private error detail");
  assert.match(acted.dispatch_error, /error_class=execution_failed/);
  assert.equal(calls.some((entry) => entry.kind === "backend-act"), true);
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "auto mode replayed a DOM action after the trusted backend had already applied focus");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function backendPostDispatchWaitFailureNeverFallsBackInAutoMode() {
  const calls = [];
  const before = browserSnapshot("https://example.test/backend-wait-unknown", "e-wait-unknown", "doc-wait-unknown");
  before.frames[0].elements[0]._machine_backend_node_id = 90;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-main";
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)], calls,
    postDispatchWaitError: Object.assign(new Error("browser wait timed out after trusted dispatch at /private/tmp/operator-secret"), { code: "ETIMEDOUT" }),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-wait-unknown" },
    input_mode: "auto", wait_for: "complete", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown", "post-dispatch wait failure was not classified as an unknown dispatch");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.dispatch_error.includes("/private/tmp/operator-secret"), false,
    "post-dispatch wait failure leaked lower-layer private error detail");
  assert.match(acted.dispatch_error, /error_class=timeout/);
  assert.equal(calls.filter((entry) => entry.kind === "backend-act").length, 1);
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "auto mode replayed the browser action after the trusted backend had already returned successfully and only wait_for failed");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function domMutationFailureStaysUnknownInComputerUse() {
  const calls = [];
  const before = browserSnapshot("https://example.test/dom-unknown", "e-dom-unknown", "doc-dom-unknown");
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)],
    calls,
    actError: new Error("browser action may have been dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-dom-unknown" },
    input_mode: "dom", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown", "DOM mutation uncertainty was not preserved by Computer Use");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1, "DOM unknown action was unexpectedly replayed");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function browserNavigationMutationFailureStaysUnknownInComputerUse() {
  const calls = [];
  const before = browserSnapshot("https://example.test/navigation-unknown", "e-nav-before", "doc-nav-before");
  const after = browserSnapshot("https://example.test/navigation-unknown", "e-nav-after", "doc-nav-after");
  const browser = browserStub({
    inspectQueue: [before, after],
    calls,
    actError: new Error("browser action may have been dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "navigate",
    url: "https://example.test/next",
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
    "ambiguous navigation mutation API failure replayed the navigation action");
  assert.match(acted.post_snapshot_id || "", /^cu_/,
    "ambiguous navigation mutation skipped the post observation required for recovery");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function browserObserveAndVerifiedAction() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/start", "e7"), browserSnapshot("https://example.test/done", "e8")],
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  assert.match(observed.snapshot_id, /^cu_/);
  assert.equal(observed.semantic.frames[0].elements[0].ref, "e7");

  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "click",
    target: { ref: "e7" },
    expect: { text: "Done", url_changed: true },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "confirmed");
  assert.notEqual(acted.post_snapshot_id, observed.snapshot_id);
  assert.equal(acted.observed_diff.url_changed, true);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "url_changed")?.evidence_source, "browser_tab_state");
  assert.equal(acted.observed_diff.document_epoch_changed, true);
  assert.equal(acted.observed_diff.semantic_delta.added_count, 1);
  assert.equal(acted.observed_diff.semantic_delta.removed_count, 1);
  assert.equal(acted.post_observation_detail, "summary");
  assert.equal(Object.hasOwn(acted.post_observation.semantic, "frames"), false, "browser post-state summary unexpectedly returned the full semantic tree");
  assert.equal(acted.continuation.snapshot_id, acted.post_snapshot_id);
  assert.equal(acted.continuation.document_epoch_same, false);
  assert.equal(acted.continuation.previous_target_ref_reusable, false);
  assert.equal(acted.continuation.reobserve_recommended, true);
  assert.deepEqual(acted.continuation.added_refs, ["e8"]);
  assert.deepEqual(acted.continuation.removed_refs, ["e7"]);
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.reason, "effect_confirmed");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.retry_guidance.next_step, "computer_observe", "confirmed navigation should not retry, but new document refs require a fresh observation");
  const postObserve = calls.filter((entry) => entry.kind === "observe")[1];
  assert.equal(postObserve.args.max_elements, 180);
  assert.equal(postObserve.args.max_ax_nodes, 180);
  assert.equal(postObserve.args.focus_query, "Continue", "post capture should keep the acted semantic target salient when possible");
  const dispatch = calls.find((entry) => entry.kind === "act");
  assert.deepEqual(dispatch.args.selector, { ref: "e7" });
  assert.equal(dispatch.args.frame_id, 3, "Computer Use must recover frame_id from the snapshot ref");
}

async function browserPostObservationCanBeFull() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/full", "e-full", "doc-full"), browserSnapshot("https://example.test/full", "e-full", "doc-full")],
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-full" },
    post_screenshot: "never", post_observation_detail: "full",
  });
  assert.equal(acted.post_observation_detail, "full");
  assert(Array.isArray(acted.post_observation.semantic.frames), "explicit full post observation did not retain browser frames");
}

async function semanticDeltaReportsStableRefChanges() {
  const before = browserSnapshot("https://example.test/delta", "e-delta", "doc-delta");
  const after = browserSnapshot("https://example.test/delta", "e-delta", "doc-delta");
  after.frames[0].elements[0].enabled = false;
  after.frames[0].elements[0].bounding_box.x = 10;
  const browser = browserStub({ inspectQueue: [before, after] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-delta" }, post_screenshot: "never",
  });
  assert.equal(acted.observed_diff.document_epoch_changed, false);
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 1);
  assert.deepEqual(acted.observed_diff.semantic_delta.changed[0].changed_fields.sort(), ["bounding_box", "enabled"]);
  assert.equal(acted.observed_diff.semantic_delta.added_count, 0);
  assert.equal(acted.observed_diff.semantic_delta.removed_count, 0);
  assert.equal(acted.continuation.document_epoch_same, true);
  assert.equal(acted.continuation.previous_target_ref_reusable, true);
  assert.equal(acted.continuation.reobserve_recommended, false);
  assert.deepEqual(acted.continuation.changed_refs, ["e-delta"]);
}

async function browserContinuationRejectsSemanticIdentityDrift() {
  const before = browserSnapshot("https://example.test/identity-continuation", "e-identity-continuation", "doc-identity-continuation");
  const after = structuredClone(before);
  after.frames[0].elements[0].name = "Delete";
  const browser = browserStub({ inspectQueue: [before, after] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click",
    target: { ref: "e-identity-continuation" }, post_screenshot: "never",
  });
  assert.equal(acted.observed_diff.document_epoch_changed, false);
  assert.equal(acted.observed_diff.frame_epoch_changed, false);
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 1);
  assert(acted.observed_diff.semantic_delta.changed[0].changed_fields.includes("name"), "semantic identity change was absent from the browser delta");
  assert.equal(acted.continuation.target_frame_epoch_same, true);
  assert.equal(acted.continuation.target_identity_continues, false);
  assert.equal(acted.continuation.previous_target_ref_reusable, false);
  assert.equal(acted.continuation.stable_ref_namespace, true);
  assert.equal(acted.continuation.reason, "target_semantic_identity_changed");
}

async function browserContinuationRejectsSiblingFrameRefCollision() {
  const before = browserSnapshot("https://example.test/frame-collision", "e-shared", "doc-frame-collision");
  const after = structuredClone(before);
  after.frames[0].frame_id = 9;
  const browser = browserStub({ inspectQueue: [before, after] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-shared" }, post_screenshot: "never",
  });
  assert.equal(acted.observed_diff.document_epoch_changed, false);
  assert.equal(acted.observed_diff.frame_epoch_changed, true);
  assert.equal(acted.continuation.target_frame_epoch_same, false);
  assert.equal(acted.continuation.target_identity_continues, false);
  assert.equal(acted.continuation.previous_target_ref_reusable, false,
    "same ref string in a sibling frame inherited the previous frame-local target identity");
  assert.equal(acted.continuation.stable_ref_namespace, false);
  assert.equal(acted.continuation.reason, "target_frame_epoch_changed");
}

async function browserContinuationRejectsChildFrameEpochReplacement() {
  const before = browserChildFrameSnapshot({ childEpoch: "doc-child-before", ref: "e-child-reused" });
  const after = browserChildFrameSnapshot({ childEpoch: "doc-child-after", ref: "e-child-reused" });
  const browser = browserStub({ inspectQueue: [before, after] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-child-reused" }, post_screenshot: "never",
  });
  assert.equal(acted.observed_diff.document_epoch_changed, false, "child-frame replacement was incorrectly promoted to a top-document replacement");
  assert.equal(acted.observed_diff.frame_epoch_changed, true);
  assert.equal(acted.observed_diff.semantic_delta.added_count, 1);
  assert.equal(acted.observed_diff.semantic_delta.removed_count, 1,
    "replacement child document reused the old semantic-delta identity key");
  assert.equal(acted.continuation.target_frame_epoch_same, false);
  assert.equal(acted.continuation.target_identity_continues, false);
  assert.equal(acted.continuation.previous_target_ref_reusable, false,
    "same-URL replacement child document inherited an old frame-local ref");
  assert.equal(acted.continuation.reason, "target_frame_epoch_changed");
}

async function browserTargetStateRejectsPostIdentityDrift() {
  const calls = [];
  const before = browserSnapshot("https://example.test/post-identity", "e-post-identity", "doc-post-identity");
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "checkbox", name: "Agree", checked: false,
    _machine_backend_node_id: 81, _machine_cdp_frame_id: "cdp-post-identity",
  };
  const after = structuredClone(before);
  after.frames[0].elements[0].checked = true;
  after.frames[0].elements[0].name = "Different control";
  const browser = browserStub({ inspectQueue: [before, after], calls, checkedState: false });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e-post-identity" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "not_observed",
    "post-state from a repurposed same-ref browser control falsely confirmed the original target effect");
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "target_identity")?.matched, false);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "target_state")?.reason, "target_semantic_identity_changed");
  assert.equal(acted.continuation.previous_target_ref_reusable, false);
}

async function browserTargetStateMissingFromTruncatedPostIsInconclusive() {
  const before = browserSnapshot("https://example.test/post-truncated", "e-post-truncated", "doc-post-truncated");
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "checkbox", name: "Agree", checked: false,
    _machine_backend_node_id: 82, _machine_cdp_frame_id: "cdp-post-truncated",
  };
  const after = structuredClone(before);
  after.frames[0].elements = [];
  after.frames[0].truncated = true;
  after.total_elements = 0;
  const browser = browserStub({ inspectQueue: [before, after], checkedState: false });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e-post-truncated" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown",
    "bounded post projection omission was misclassified as a definite target-state failure");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "target_state")?.reason, "post_target_coverage_incomplete");
}

async function browserTargetStateMissingFrameFromTruncatedPostIsInconclusive() {
  const before = browserSnapshot("https://example.test/post-frame-truncated", "e-post-frame-truncated", "doc-post-frame-truncated");
  before.frames[0].elements[0] = {
    ...before.frames[0].elements[0], role: "checkbox", name: "Agree", checked: false,
    _machine_backend_node_id: 83, _machine_cdp_frame_id: "cdp-post-frame-truncated",
  };
  const after = structuredClone(before);
  after.frames = [];
  after.frames_truncated = true;
  after.total_elements = 0;
  const browser = browserStub({ inspectQueue: [before, after], checkedState: false });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e-post-frame-truncated" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "target_state")?.reason,
    "post_target_frame_coverage_incomplete",
  "missing target frame in a truncated post inventory was treated as definite target disappearance");
}

async function missingPostObservationRequiresReobserve() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/missing-post", "e-missing")] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-missing" }, post_screenshot: "never",
  });
  assert.equal(acted.post_snapshot_id, null);
  assert.equal(acted.continuation.available, false);
  assert.equal(acted.continuation.reobserve_recommended, true);
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.next_step, "computer_observe");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.post_observation_error, /browser post observation unavailable \(error_class=execution_failed\)/);
}

async function postOnlyBrowserExpectationWithoutPostStateStaysUnknown() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/pending-post", "e-pending", "doc-pending")] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-pending" },
    expect: { semantic_change: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "unknown", "missing post observation falsely confirmed a post-only browser expectation");
  assert.equal(acted.verification.matched, false);
  assert.equal(acted.verification.wait_matched, true);
  assert.equal(acted.verification.post_check_pending, true);
  assert.equal(acted.verification.reason, "post_conditions_pending");
  assert.equal(acted.retry_guidance.disposition, "reobserve_before_retry");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function mixedBrowserExpectationWithoutPostStateStaysUnknown() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/mixed-pending", "e-mixed", "doc-mixed")] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-mixed" },
    expect: { text: "Done", url_changed: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "unknown", "successful browser wait incorrectly substituted for a missing url_changed post check");
  assert.equal(acted.verification.wait_matched, true);
  assert.equal(acted.verification.post_check_pending, true);
  assert.equal(acted.retry_guidance.disposition, "reobserve_before_retry");
}

async function explicitSemanticChangeCanConfirmEffect() {
  const before = browserSnapshot("https://example.test/semantic", "e-sem", "doc-sem");
  const after = browserSnapshot("https://example.test/semantic", "e-sem", "doc-sem");
  after.frames[0].elements[0].enabled = false;
  const browser = browserStub({ inspectQueue: [before, after] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-sem" },
    expect: { semantic_change: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.verification.post_checks[0].condition, "semantic_change");
  assert.equal(acted.verification.post_checks[0].evidence_source, "browser_semantic");
  assert.equal(acted.observed_diff.semantic_changed, true);
}

async function unobservedExpectedEffectUsesPostSnapshotBeforeRetry() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/not-observed", "e-not", "doc-not"), browserSnapshot("https://example.test/not-observed", "e-not", "doc-not")],
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-not" },
    expect: { semantic_change: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "not_observed");
  assert.equal(acted.retry_guidance.disposition, "use_post_snapshot");
  assert.equal(acted.retry_guidance.next_step, "continue_from_post_snapshot");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.retry_guidance.post_snapshot_id, acted.post_snapshot_id);
  assert.match(acted.recovery, /replan before considering any retry/i);
}

async function explicitVisualChangeCanConfirmEffect() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/canvas", "e-vis", "doc-vis"), browserSnapshot("https://example.test/canvas", "e-vis", "doc-vis")],
    screenshotHashes: ["a".repeat(64), "b".repeat(64)],
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const actedResult = await manager.act({
    surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "click", target: { ref: "e-vis" },
    expect: { visual_change: true },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.observed_diff.screenshot_changed, true);
  assert.equal(acted.verification.post_checks[0].condition, "visual_change");
  assert.equal(acted.verification.post_checks[0].evidence_source, "screenshot");
  assert.equal(acted.verification.post_checks[0].observed, true);
}

async function visualChangeRequiresBaselineScreenshot() {
  const calls = [];
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/no-image", "e-noimg")], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-noimg" },
      expect: { visual_change: true },
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /requires.*snapshot.*screenshot/i.test(error.message),
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "visual expectation without baseline screenshot reached dispatch");
}

async function autoPostScreenshotSkipsRedundantSemanticImage() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/auto", "e-auto", "doc-auto"), browserSnapshot("https://example.test/auto", "e-auto", "doc-auto")],
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-auto" },
    expect: { semantic_change: false },
  });
  assert.equal(Boolean(acted.$mcp), false, "ordinary semantic action unexpectedly returned a post image under auto policy");
  assert.equal(acted.post_screenshot_policy, "auto");
  assert.equal(acted.post_screenshot_included, false);
  const postObserve = calls.filter((entry) => entry.kind === "observe")[1];
  assert.equal(postObserve.args.include_screenshot, false);
}

async function autoPostScreenshotCapturesUnknownDispatch() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/unknown-auto", "e-u1", "doc-u"), browserSnapshot("https://example.test/unknown-auto", "e-u1", "doc-u")],
    actError: new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const actedResult = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-u1" },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.post_screenshot_policy, "auto");
  assert.equal(acted.post_screenshot_included, true);
  assert.equal(acted.retry_guidance.disposition, "use_post_snapshot");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.recovery, /ambiguous/i);
  assert.equal(actedResult.$mcp.content[1].type, "image");
}

async function postScreenshotIncludedTracksActualImage() {
  const applications = appStub({
    inspectQueue: [appSnapshot(true, false), appSnapshot(true, false), appSnapshot(true, true)],
    screenshotError: new Error("window screenshot unavailable"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
    post_screenshot: "always",
  });
  assert.equal(Boolean(acted.$mcp), false, "failed post screenshot unexpectedly produced MCP image content");
  assert.equal(acted.post_screenshot_policy, "always");
  assert.equal(acted.post_screenshot_included, false, "post result claimed an image that was not returned");
  assert.match(acted.post_snapshot_id || "", /^cu_/);
  const stored = manager.snapshots.items.get(acted.post_snapshot_id);
  assert.equal(stored?.observation?.capture?.screenshot, false);
  assert.match(stored?.observation?.capture?.screenshot_error || "", /screenshot|capture/i);
}

async function postScreenshotPoliciesAreValidated() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/policy", "e-policy")] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const id = observed.$mcp.structuredContent.snapshot_id;
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: id, action: "click", target: { ref: "e-policy" },
      post_screenshot: "always", include_post_screenshot: true,
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /no longer supported/.test(error.message),
  );
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: id, action: "click", target: { ref: "e-policy" },
      expect: { visual_change: true }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /visual_change/.test(error.message),
  );
}

async function staleBrowserSnapshotIsRejectedBeforeDispatch() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/one", "e1")],
    tabUrl: "https://example.test/two",
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_screenshot: "never" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "stale snapshots must fail before dispatch");

  const coercibleUrlCalls = [];
  const exactUrl = "https://example.test/coercible-live-url";
  const coercibleUrlBrowser = browserStub({
    inspectQueue: [browserSnapshot(exactUrl, "e-live-url", "doc-live-url")], tabUrl: [exactUrl], calls: coercibleUrlCalls,
  });
  const coercibleUrlManager = managerWith({ browser: coercibleUrlBrowser });
  const coercibleUrlObserved = await coercibleUrlManager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => coercibleUrlManager.act({
      surface: "browser", snapshot_id: coercibleUrlObserved.snapshot_id, action: "click", target: { ref: "e-live-url" }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(coercibleUrlCalls.some((entry) => entry.kind === "act"), false,
    "coercible live tab URL satisfied snapshot identity before dispatch");

  const coercibleEpochCalls = [];
  const coercibleEpochBrowser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/coercible-live-epoch", "e-live-epoch", "doc-live-epoch")],
    documentStateEpoch: ["doc-live-epoch"], calls: coercibleEpochCalls,
  });
  const coercibleEpochManager = managerWith({ browser: coercibleEpochBrowser });
  const coercibleEpochObserved = await coercibleEpochManager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => coercibleEpochManager.act({
      surface: "browser", snapshot_id: coercibleEpochObserved.snapshot_id, action: "click", target: { ref: "e-live-epoch" }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(coercibleEpochCalls.some((entry) => entry.kind === "act"), false,
    "coercible live document epoch satisfied snapshot identity before dispatch");

  const coercibleIdentityCalls = [];
  const coercibleIdentitySnapshot = browserSnapshot("https://example.test/coercible-ref-identity", "e-ref-identity", "doc-ref-identity");
  coercibleIdentitySnapshot.frames[0].elements[0].role = ["button"];
  const coercibleIdentityBrowser = browserStub({ inspectQueue: [coercibleIdentitySnapshot], calls: coercibleIdentityCalls });
  const coercibleIdentityManager = managerWith({ browser: coercibleIdentityBrowser });
  const coercibleIdentityObserved = await coercibleIdentityManager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => coercibleIdentityManager.act({
      surface: "browser", snapshot_id: coercibleIdentityObserved.snapshot_id, action: "click", target: { ref: "e-ref-identity" }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(coercibleIdentityCalls.some((entry) => entry.kind === "act"), false,
    "coercible browser snapshot element identity reached the mutation backend");
}

async function sameUrlReloadSnapshotIsRejectedBeforeDispatch() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/same", "e11", "doc-before")],
    documentStateEpoch: "doc-after",
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e11" }, post_screenshot: "never" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "same-URL document replacement must fail before dispatch");
}

async function targetlessHistoryActionsRequireDocumentPreflight() {
  for (const action of ["reload", "back", "forward"]) {
    const calls = [];
    const browser = browserStub({
      inspectQueue: [browserSnapshot(`https://example.test/${action}`, `e-${action}`, `doc-${action}`)],
      documentStateError: Object.assign(new Error("document state unavailable at /private/tmp/operator-secret"), { code: "ETIMEDOUT" }),
      calls,
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser", include_screenshot: false });
    await assert.rejects(
      () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action, post_screenshot: "never" }),
      (error) => error instanceof BridgeError
        && error.code === "unavailable"
        && error.details?.reason === "browser_document_preflight_unavailable"
        && error.details?.error_class === "timeout"
        && !JSON.stringify(error.details).includes("/private/tmp/operator-secret")
        && !Object.hasOwn(error.details || {}, "detail"),
    );
    assert.equal(calls.some((entry) => entry.kind === "act"), false,
      `${action} reached browser mutation without a verified snapshot document epoch`);
  }
}

async function navigateDoesNotRequireDocumentEpochPreflight() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/original", "e-nav", "doc-nav")],
    documentStateError: new Error("document state unavailable"),
    actError: new Error("navigate reached dispatch"),
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "navigate",
      url: "https://example.test/next", post_screenshot: "never",
    }),
    /navigate reached dispatch/,
  );
  const dispatched = calls.find((entry) => entry.kind === "act");
  assert.equal(Boolean(dispatched), true,
    "explicit navigate was incorrectly blocked by an unavailable old-document epoch read");
  assert.equal(dispatched.args.expected_tab_url, "https://example.test/original",
    "explicit navigate did not carry the observed tab URL to its last-hop concurrency check");
  assert.equal(dispatched.args.expected_document_epoch, undefined,
    "explicit navigate was incorrectly coupled to the old document epoch");
  assert.equal(dispatched.args.expected_history_entry_key, undefined,
    "explicit navigate was incorrectly coupled to the old history-entry key");
}

async function navigationActionMapsLastHopUrlRace() {
  for (const fixture of [
    {
      message: "snapshot browser tab changed before navigation dispatch; observe again",
      code: "conflict",
      reason: "stale_snapshot",
    },
    {
      message: "snapshot browser tab could not be verified before navigation dispatch; observe again",
      code: "unavailable",
      reason: "browser_navigation_last_hop_unavailable",
    },
  ]) {
    const calls = [];
    const browser = browserStub({
      inspectQueue: [browserSnapshot("https://example.test/navigation-race", "e-nav-race", "doc-nav-race")],
      actError: new Error(fixture.message),
      calls,
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser", include_screenshot: false });
    await assert.rejects(
      () => manager.act({
        surface: "browser", snapshot_id: observed.snapshot_id, action: "navigate",
        url: "https://example.test/destination", post_screenshot: "never",
      }),
      (error) => error instanceof BridgeError && error.code === fixture.code && error.details?.reason === fixture.reason,
    );
    assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
      "last-hop navigation URL verification failure caused an automatic replay");
  }
}

async function historyActionForwardsEpochAndMapsLastHopStale() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/history", "e-history", "doc-history")],
    actError: new Error("snapshot history document changed before dispatch; observe again"),
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "reload", post_screenshot: "never" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  const dispatched = calls.find((entry) => entry.kind === "act");
  assert.equal(dispatched?.args?.expected_tab_url, "https://example.test/history",
    "snapshot-bound reload did not carry the observed tab URL to the last-hop browser action");
  assert.equal(dispatched?.args?.expected_document_epoch, "doc-history",
    "snapshot-bound reload did not carry the observed document epoch to the last-hop browser action");
  assert.equal(dispatched?.args?.expected_history_entry_key, "history-e-history",
    "snapshot-bound reload did not carry the observed history-entry authority to the last-hop browser action");
}

async function historyActionRejectsMissingEntryAuthorityBeforeDispatch() {
  const calls = [];
  const snapshot = browserSnapshot("https://example.test/history-missing", "e-history-missing", "doc-history-missing");
  snapshot._machine_history_entry_key = "";
  const browser = browserStub({ inspectQueue: [snapshot], documentStateHistoryEntryKey: "", calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "back", post_screenshot: "never" }),
    (error) => error instanceof BridgeError
      && error.code === "unavailable"
      && error.details?.reason === "browser_history_preflight_unavailable",
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "history action reached browser mutation without an observed history-entry authority");
}

async function historyActionRejectsChangedEntryBeforeDispatch() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/history-changed", "e-history-changed", "doc-history-changed")],
    documentStateHistoryEntryKey: "history-other-slot",
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "forward", post_screenshot: "never" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "changed history entry reached browser mutation despite snapshot-bound authority mismatch");
}

async function historyEntryLastHopSettlementIsSnapshotBound() {
  for (const fixture of [
    {
      message: "snapshot history entry changed before dispatch; observe again",
      code: "conflict",
      reason: "stale_snapshot",
    },
    {
      message: "snapshot history entry could not be verified before dispatch; observe again",
      code: "unavailable",
      reason: "browser_history_last_hop_unavailable",
    },
    {
      message: "snapshot browser history has no back entry before dispatch; observe again",
      code: "unavailable",
      reason: "browser_history_direction_unavailable",
    },
    {
      message: "snapshot browser history has no forward entry before dispatch; observe again",
      code: "unavailable",
      reason: "browser_history_direction_unavailable",
    },
    {
      message: "snapshot history mutation API is unavailable before dispatch; observe again",
      code: "unavailable",
      reason: "browser_history_mutation_api_unavailable",
    },
  ]) {
    const calls = [];
    const browser = browserStub({
      inspectQueue: [browserSnapshot("https://example.test/history-entry-last-hop", "e-history-entry", "doc-history-entry")],
      actError: new Error(fixture.message),
      calls,
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser", include_screenshot: false });
    assert.equal(JSON.stringify(observed).includes("history-e-history-entry"), false,
      "private browser history-entry key leaked into public Computer Use observation");
    await assert.rejects(
      () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "back", post_screenshot: "never" }),
      (error) => error instanceof BridgeError && error.code === fixture.code && error.details?.reason === fixture.reason,
    );
    const dispatches = calls.filter((entry) => entry.kind === "act");
    assert.equal(dispatches.length, 1, "last-hop history-entry verification failure caused an automatic replay");
    assert.equal(dispatches[0].args.expected_history_entry_key, "history-e-history-entry",
      "snapshot-bound history action dropped its private history-entry key before the last hop");
  }
}

async function historyActionMapsLastHopUnavailable() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/history-unavailable", "e-history-u", "doc-history-u")],
    actError: new Error("snapshot history document could not be verified before dispatch; observe again"),
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "back", post_screenshot: "never" }),
    (error) => error instanceof BridgeError
      && error.code === "unavailable"
      && error.details?.reason === "browser_document_last_hop_unavailable",
  );
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
    "last-hop history document verification failure caused an automatic replay");
}

async function browserRefIdentityDriftMapsToStaleWithoutReplay() {
  const calls = [];
  const before = browserSnapshot("https://example.test/identity-drift", "e-identity", "doc-identity");
  const browser = browserStub({
    inspectQueue: [before],
    calls,
    actError: new Error("snapshot ref identity changed before dispatch; observe again"),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "browser",
      snapshot_id: observed.snapshot_id,
      action: "click",
      target: { ref: "e-identity" },
      input_mode: "dom",
      post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError
      && error.code === "conflict"
      && error.details?.reason === "stale_snapshot"
      && /semantic target identity changed/.test(error.message),
  );
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
    "semantic identity drift replayed the same browser action");
}

async function visualPointDispatchIsSnapshotBound() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/visual", "e-v1"), browserSnapshot("https://example.test/visual", "e-v2")],
    enhanced: true,
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  assert.equal(observed.$mcp.structuredContent.capabilities.snapshot_bound_visual_points, true);
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "click",
    target: { point: { x: 0.5, y: 0.25, space: "normalized_viewport" } },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  const pointCall = calls.find((entry) => entry.kind === "point-act");
  assert.equal(pointCall.args.normalized_x, 0.5);
  assert.equal(pointCall.args.normalized_y, 0.25);
  assert.equal(pointCall.args.document_epoch, "doc-e-v1");
  assert.deepEqual(pointCall.args.viewport, { width: 800, height: 600, scale: 1 });
  assert.equal(pointCall.args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(pointCall.args.screenshot_format, "png");
  assert.equal(pointCall.args.screenshot_quality, 90);
}

async function visualPointRejectsCoercibleSnapshotAuthority() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/visual-schema", "e-vschema")], enhanced: true, calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const snapshotId = observed.$mcp.structuredContent.snapshot_id;
  for (const point of [
    { x: [0.5], y: 0.25 },
    { x: 0.5, y: 0.25, space: ["normalized_viewport"] },
  ]) {
    await assert.rejects(
      () => manager.act({ surface: "browser", snapshot_id: snapshotId, action: "click", target: { point }, post_screenshot: "never" }),
      (error) => error instanceof BridgeError && error.code === "invalid_request",
    );
  }
  assert.equal(calls.some((entry) => entry.kind === "point-act"), false,
    "coercible browser point target reached the visual dispatcher");

  const malformedCalls = [];
  const malformedBrowser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/visual-hash-schema", "e-vhash")], enhanced: true,
    screenshotHashes: [["a".repeat(64)]], calls: malformedCalls,
  });
  const malformedManager = managerWith({ browser: malformedBrowser });
  const malformedObserved = await malformedManager.observe({ surface: "browser" });
  assert.equal(malformedObserved.$mcp.structuredContent.capabilities.snapshot_bound_visual_points, false,
    "coercible browser screenshot digest retained visual-point capability");
  await assert.rejects(
    () => malformedManager.act({
      surface: "browser", snapshot_id: malformedObserved.$mcp.structuredContent.snapshot_id, action: "click",
      target: { point: { x: 0.5, y: 0.25 } }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict",
  );
  assert.equal(malformedCalls.some((entry) => entry.kind === "point-act"), false,
    "coercible browser screenshot digest reached the visual dispatcher");
}

async function visualPointDragIsSnapshotBound() {
  const calls = [];
  const before = browserSnapshot("https://example.test/visual-drag", "e-vd1");
  const after = browserSnapshot("https://example.test/visual-drag", "e-vd2");
  const browser = browserStub({ inspectQueue: [before, after], enhanced: true, calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.$mcp.structuredContent.snapshot_id,
    action: "drag",
    target: { point: { x: 0.2, y: 0.3 } },
    destination: { point: { x: 0.8, y: 0.7 } },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "drag dispatch without an explicit post-condition was promoted to effect success");
  const pointCalls = calls.filter((entry) => entry.kind === "point-act");
  assert.equal(pointCalls.length, 1, "snapshot-bound point drag was split into multiple mutating calls");
  assert.equal(pointCalls[0].args.action, "drag");
  assert.equal(pointCalls[0].args.normalized_x, 0.2);
  assert.equal(pointCalls[0].args.normalized_y, 0.3);
  assert.equal(pointCalls[0].args.destination_normalized_x, 0.8);
  assert.equal(pointCalls[0].args.destination_normalized_y, 0.7);
  assert.equal(pointCalls[0].args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(acted.dispatch.destination_point.normalized_x, 0.8);
  assert.equal(acted.dispatch.destination_point.normalized_y, 0.7);
}

async function visualPointScrollIsSnapshotBound() {
  const calls = [];
  const before = browserSnapshot("https://example.test/visual-scroll", "e-vs1");
  const after = browserSnapshot("https://example.test/visual-scroll", "e-vs2");
  const browser = browserStub({ inspectQueue: [before, after], enhanced: true, calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.$mcp.structuredContent.snapshot_id,
    action: "scroll",
    target: { point: { x: 0.35, y: 0.65 } },
    delta_x: -80,
    delta_y: 640,
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "scroll dispatch without an explicit post-condition was promoted to effect success");
  const pointCalls = calls.filter((entry) => entry.kind === "point-act");
  assert.equal(pointCalls.length, 1, "snapshot-bound point scroll was split into multiple mutating calls");
  assert.equal(pointCalls[0].args.action, "scroll");
  assert.equal(pointCalls[0].args.normalized_x, 0.35);
  assert.equal(pointCalls[0].args.normalized_y, 0.65);
  assert.equal(pointCalls[0].args.delta_x, -80);
  assert.equal(pointCalls[0].args.delta_y, 640);
  assert.equal(pointCalls[0].args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(acted.dispatch.scroll_delta.delta_x, -80);
  assert.equal(acted.dispatch.scroll_delta.delta_y, 640);
}

async function semanticRefDragUsesBothTrustedBindings() {
  const calls = [];
  const before = browserSnapshot("https://example.test/ref-drag", "e-source", "doc-ref-drag");
  before.frames[0].frame_id = 0;
  before.frames[0].elements[0]._machine_backend_node_id = 42;
  before.frames[0].elements.push({
    ref: "e-destination", role: "listitem", name: "Destination", visible: true, enabled: true,
    bounding_box: { x: 300, y: 200, width: 80, height: 40 },
    _machine_backend_node_id: 77,
  });
  before.total_elements = 2;
  const browser = browserStub({ inspectQueue: [before, structuredClone(before)], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "drag",
    target: { ref: "e-source" }, destination: { ref: "e-destination" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  const backendCalls = calls.filter((entry) => entry.kind === "backend-act");
  assert.equal(backendCalls.length, 1, "semantic drag did not remain one trusted backend mutation");
  assert.equal(backendCalls[0].args.backend_node_id, 42);
  assert.equal(backendCalls[0].args.destination_backend_node_id, 77);
  assert.equal(backendCalls[0].args.extension_ref, "e-source");
  assert.equal(backendCalls[0].args.destination_extension_ref, "e-destination");
  assert.equal(backendCalls[0].args.destination_expected_ref_identity.role, "listitem");
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "semantic drag fell back to a non-snapshot browser action");
}

async function semanticRefScrollUsesTrustedBinding() {
  const calls = [];
  const before = browserSnapshot("https://example.test/ref-scroll", "e-scroll", "doc-ref-scroll");
  before.frames[0].frame_id = 0;
  before.frames[0].elements[0]._machine_backend_node_id = 42;
  const browser = browserStub({ inspectQueue: [before, structuredClone(before)], calls });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "scroll",
    target: { ref: "e-scroll" }, delta_x: 0, delta_y: 520,
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  const backendCalls = calls.filter((entry) => entry.kind === "backend-act");
  assert.equal(backendCalls.length, 1, "semantic scroll did not remain one trusted backend mutation");
  assert.equal(backendCalls[0].args.backend_node_id, 42);
  assert.equal(backendCalls[0].args.extension_ref, "e-scroll");
  assert.equal(backendCalls[0].args.delta_x, 0);
  assert.equal(backendCalls[0].args.delta_y, 520);
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "semantic scroll fell back to a non-snapshot browser action");
}

async function malformedLowerLayerDispatchEvidenceIsNotCoerced() {
  const calls = [];
  const before = browserSnapshot("https://example.test/malformed-dispatch-evidence", "e-evidence", "doc-evidence");
  before.frames[0].elements[0]._machine_backend_node_id = 91;
  before.frames[0].elements[0]._machine_cdp_frame_id = "cdp-evidence";
  const after = structuredClone(before);
  const browser = browserStub({ inspectQueue: [before, after], calls });
  browser.backendNodeAction = async (args) => {
    calls.push({ kind: "backend-act", args });
    return {
      ok: true, input_mode: "trusted", trusted_input_fallback: false, coordinate_source: "cdp_content_quad",
      cross_frame_trusted: false, tab_id: 41, url: "https://example.test/malformed-dispatch-evidence", title: "Example",
      tab_metadata_verified: true, point: { x: "150", y: [120] },
      scroll_delta: { delta_x: [args.delta_x], delta_y: String(args.delta_y) },
    };
  };
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "scroll", target: { ref: "e-evidence" },
    delta_x: 20, delta_y: 300, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(Object.hasOwn(acted.dispatch, "point"), false,
    "coercible lower-layer point metadata was projected as trusted dispatch evidence");
  assert.equal(Object.hasOwn(acted.dispatch, "scroll_delta"), false,
    "coercible lower-layer scroll metadata was projected as trusted dispatch evidence");
}

async function browserDragRejectsMixedEndpointEvidence() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/mixed-drag", "e-mixed")],
    enhanced: true,
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "drag",
      target: { ref: "e-mixed" }, destination: { point: { x: 0.8, y: 0.8 } },
      post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /both use refs or both use normalized points/.test(error.message),
  );
  assert.equal(calls.some((entry) => entry.kind === "backend-act" || entry.kind === "point-act" || entry.kind === "act"), false,
    "mixed-evidence drag reached a mutating browser path");
}

async function browserDragRejectsUnsafeOptionsBeforeDispatch() {
  for (const fixture of [
    { label: "missing destination", extra: {}, pattern: /browser drag requires destination/ },
    { label: "DOM input", extra: { destination: { point: { x: 0.8, y: 0.8 } }, input_mode: "dom" }, pattern: /requires trusted browser input/ },
    { label: "wait_for", extra: { destination: { point: { x: 0.8, y: 0.8 } }, wait_for: "complete" }, pattern: /wait_for is not supported for drag/ },
  ]) {
    const calls = [];
    const browser = browserStub({
      inspectQueue: [browserSnapshot(`https://example.test/drag-${fixture.label.replace(/ /g, "-")}`, "e-drag-guard")],
      enhanced: true,
      calls,
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser" });
    await assert.rejects(
      () => manager.act({
        surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "drag",
        target: { point: { x: 0.2, y: 0.2 } }, post_screenshot: "never",
        ...fixture.extra,
      }),
      fixture.pattern,
      `${fixture.label} drag was not rejected before trusted dispatch`,
    );
    assert.equal(calls.some((entry) => entry.kind === "backend-act" || entry.kind === "point-act" || entry.kind === "act"), false,
      `${fixture.label} drag reached a mutating browser path`);
  }
}

async function browserDragUnknownDispatchIsNotReplayed() {
  const calls = [];
  const before = browserSnapshot("https://example.test/drag-unknown", "e-drag-unknown");
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)], enhanced: true, calls,
    pointActionError: new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "drag",
    target: { point: { x: 0.2, y: 0.2 } }, destination: { point: { x: 0.8, y: 0.8 } },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown", "partial drag failure was not preserved as ambiguous dispatch");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false, "partial drag failure allowed same-action retry");
  assert.equal(calls.filter((entry) => entry.kind === "point-act").length, 1, "partial drag was replayed through trusted point input");
  assert.equal(calls.some((entry) => entry.kind === "act" || entry.kind === "backend-act"), false,
    "partial drag fell back to another browser mutation path");
}

async function browserScrollRejectsUnsafeOptionsBeforeDispatch() {
  for (const fixture of [
    { label: "zero delta", extra: { delta_x: 0, delta_y: 0 }, pattern: /requires a non-zero delta_x or delta_y/ },
    { label: "oversized delta", extra: { delta_y: 10001 }, pattern: /delta_y must be a finite number from -10000 to 10000/ },
    { label: "DOM input", extra: { delta_y: 500, input_mode: "dom" }, pattern: /requires trusted browser input/ },
    { label: "wait_for", extra: { delta_y: 500, wait_for: "complete" }, pattern: /wait_for is not supported for scroll/ },
  ]) {
    const calls = [];
    const browser = browserStub({
      inspectQueue: [browserSnapshot(`https://example.test/scroll-${fixture.label.replace(/ /g, "-")}`, "e-scroll-guard")],
      enhanced: true,
      calls,
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser" });
    await assert.rejects(
      () => manager.act({
        surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "scroll",
        target: { point: { x: 0.4, y: 0.4 } }, post_screenshot: "never",
        ...fixture.extra,
      }),
      fixture.pattern,
      `${fixture.label} scroll was not rejected before trusted dispatch`,
    );
    assert.equal(calls.some((entry) => entry.kind === "backend-act" || entry.kind === "point-act" || entry.kind === "act"), false,
      `${fixture.label} scroll reached a mutating browser path`);
  }
}

async function browserScrollUnknownDispatchIsNotReplayed() {
  const calls = [];
  const before = browserSnapshot("https://example.test/scroll-unknown", "e-scroll-unknown");
  const browser = browserStub({
    inspectQueue: [before, structuredClone(before)], enhanced: true, calls,
    pointActionError: new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  const acted = await manager.act({
    surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "scroll",
    target: { point: { x: 0.5, y: 0.5 } }, delta_y: 600,
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown", "wheel response loss was not preserved as ambiguous dispatch");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false, "ambiguous scroll allowed same-action retry");
  assert.equal(calls.filter((entry) => entry.kind === "point-act").length, 1, "ambiguous scroll was replayed through trusted point input");
  assert.equal(calls.some((entry) => entry.kind === "act" || entry.kind === "backend-act"), false,
    "ambiguous scroll fell back to another browser mutation path");
}

async function visualPointViewportDriftIsRejected() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/visual", "e-v3")],
    enhanced: true,
    documentStateViewport: { width: 700, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
    calls,
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "click",
      target: { point: { x: 0.4, y: 0.4 } }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "point-act"), false, "viewport drift must fail before visual input dispatch");
}

async function visualPointScreenshotDriftIsRejectedAsStale() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/visual-drift", "e-v5")],
    enhanced: true,
    pointActionError: new Error("trusted browser input unavailable: visual_snapshot_changed_before_dispatch"),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "click",
      target: { point: { x: 0.25, y: 0.25 } }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot" && /screenshot changed/.test(error.message),
  );
}

async function legacySnapshotCannotDispatchVisualPoint() {
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/legacy", "e-v4")] });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser" });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.$mcp.structuredContent.snapshot_id, action: "click",
      target: { point: { x: 0.5, y: 0.5 } }, post_screenshot: "never",
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "visual_snapshot_not_actionable",
  );
}

async function unknownDispatchCanStillBeEffectConfirmed() {
  const calls = [];
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/a", "e2"), browserSnapshot("https://example.test/b", "e3")],
    calls,
    actError: new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying."),
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "click",
    target: { ref: "e2" },
    expect: { text: "Complete" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "confirmed", "effect verification must be independent from dispatch certainty");
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.dispatch_error, /outcome is unknown/i);
}

async function unverifiedMutationStaysUnknown() {
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/a", "e4"), browserSnapshot("https://example.test/a", "e4")],
  });
  const manager = managerWith({ browser });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const acted = await manager.act({
    surface: "browser",
    snapshot_id: observed.snapshot_id,
    action: "click",
    target: { ref: "e4" },
    post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "successful event dispatch must not be promoted to business-effect success");
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.reason, "dispatch_completed_without_effect_contract");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.recovery, /Do not replay/i);
}


async function semanticMetadataCannotConfirmAnEffect() {
  for (const expected of [true, false]) {
    const before = browserSnapshot("https://example.test/unchanged-metadata", "e-metadata", "doc-metadata");
    const after = structuredClone(before);
    before.frames[0].document = { ...before.frames[0].document, tracked_refs: 1, selection_strategy: "salience", focus_query_applied: false };
    after.max_elements = 180;
    after.selection = { strategy: "salience+focus_query", returned_elements: 1 };
    after.frames[0].document = { ...before.frames[0].document, tracked_refs: 2, selection_strategy: "salience+focus_query", focus_query_applied: true };
    after.frames[0].elements[0].salience_score = 900;
    after.frames[0].elements[0].focus_match_score = 800;
    const manager = managerWith({ browser: browserStub({ inspectQueue: [before, after] }) });
    const observation = await manager.observe({ surface: "browser", include_screenshot: false });
    const result = await manager.act({ surface: "browser", snapshot_id: observation.snapshot_id,
      action: "click", target: { ref: "e-metadata" }, expect: { semantic_change: expected }, post_screenshot: "never" });
    assert.equal(result.observed_diff.semantic_changed, false, "capture metadata was mistaken for page change");
    assert.equal(result.effect_status, expected ? "not_observed" : "confirmed");
  }
}

async function incompleteSemanticCoverageCannotConfirmPresenceChanges() {
  for (const expected of [true, false]) {
    const before = browserSnapshot("https://example.test/incomplete-semantics", "e-partial", "doc-partial");
    before.frames[0].elements.push({ ...before.frames[0].elements[0], ref: "e-other", name: "Other" });
    const after = structuredClone(before);
    after.frames[0].elements.pop();
    after.frames[0].truncated = true;
    const manager = managerWith({ browser: browserStub({ inspectQueue: [before, after] }) });
    const observation = await manager.observe({ surface: "browser", include_screenshot: false });
    const result = await manager.act({ surface: "browser", snapshot_id: observation.snapshot_id,
      action: "click", target: { ref: "e-partial" }, expect: { semantic_change: expected }, post_screenshot: "never" });
    assert.equal(result.observed_diff.semantic_changed, null, "incomplete sampling was mistaken for known page change");
    assert.equal(result.effect_status, "unknown");
    assert.equal(result.verification.inconclusive, true);
  }
  const before = { surface: "application", target: { application: "synthetic", process_name: "synthetic" },
    semantic: { elements: [{ identifier: "one", role: "AXButton", name: "One" }, { identifier: "two", role: "AXButton", name: "Two" }], truncated: false } };
  const after = { ...before, semantic: { elements: before.semantic.elements.slice(0, 1), truncated: true } };
  const privateState = { application_process_id: 1, application_process_generation: "synthetic" };
  assert.equal(observationDiff(before, after, privateState, privateState).semantic_changed, null,
    "application omitted controls were treated as a confirmed semantic effect");
  const changed = structuredClone(after);
  changed.semantic.elements[0].focused = true;
  assert.equal(observationDiff(before, changed, privateState, privateState).semantic_changed, true,
    "an observed shared control state change must remain evidence even with partial coverage");
}
