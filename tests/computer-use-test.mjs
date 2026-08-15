import assert from "node:assert/strict";
import { ComputerUseManager } from "../src/local/computer-use.mjs";
import { ComputerUseSnapshotStore } from "../src/local/computer-use-snapshot-store.mjs";
import { buildBrowserObservation, buildContinuation, extractBrowserPrivateBindings, observationDiff, projectPostObservation } from "../src/local/computer-use-observation.mjs";
import { BridgeError } from "../src/local/errors.mjs";

const PNG_A_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_B_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=";
const PNG_A_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

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
await applicationFocusQueryRanksBoundedObservation();
await applicationObservationReturnsWindowScreenshot();
await oversizedApplicationScreenshotDegradesBeforeSnapshotPublication();
await oversizedPostScreenshotCompactsWithoutLosingContinuation();
await applicationWindowChangeDuringObservationDisablesPointGeometry();
await applicationWindowRevalidationFailureIsExplicit();
await cancelledApplicationWindowRevalidationDoesNotPublishSnapshot();
await applicationScreenshotFailureKeepsAccessibility();
await applicationPostActionDoesNotRepeatScreenshot();
await applicationVisualPointIsWindowAndScreenshotBound();
await applicationVisualPointRejectsCoercibleSnapshotAuthority();
await applicationVisualDoubleClickIsSingleWindowBoundSettlement();
await applicationVisualDoubleClickUnknownSettlementIsNotReplayed();
await applicationVisualDoubleClickRejectsSemanticTarget();
await applicationHoverIsRejectedFailClosed();
await applicationVisualDragIsWindowAndScreenshotBound();
await applicationVisualDragRequiresPixelBackend();
await applicationVisualDragUnknownDispatchReturnsEvidence();
await staleApplicationVisualDragIsRejectedBeforeDispatch();
await applicationVisualDragRejectsSemanticEndpoints();
await applicationVisualScrollIsWindowAndScreenshotBound();
await applicationVisualScrollRequiresPixelBackend();
await applicationVisualScrollUnknownDispatchReturnsEvidence();
await staleApplicationVisualScrollIsRejectedBeforeDispatch();
await applicationVisualScrollRejectsSemanticAnchor();
await applicationVisualPointReportsSemanticCandidates();
await applicationVisualChangeCanConfirmEffect();
await applicationVisualUnknownDispatchReturnsEvidence();
await staleApplicationVisualPointIsRejectedBeforeDispatch();
await applicationWithoutWindowScreenshotRejectsVisualPoint();
await applicationDisabledBackendDoesNotExposeVisualPoint();
await applicationFailedProbeKeepsScreenshotButRejectsVisualPoint();
await applicationSemanticPointUsesAccessibilityWithoutPixelBackend();
await truncatedApplicationObservationDoesNotClaimSemanticPointUniqueness();
await ambiguousApplicationSemanticPointDoesNotGuess();
await semanticPointRejectsNewLiveOverlap();
await semanticPointRejectsIncompleteLiveCoverage();
await staleApplicationSemanticPointScreenshotRejectsBeforeAccessibilityDispatch();
await applicationCheckboxClickUsesIntrinsicReadback();
await applicationCheckboxNoopIsNotObserved();
await applicationExplicitSelectionExpectationUsesReadback();
await applicationCheckAndUncheckUseDesiredStateReadback();
await applicationVerificationPollsReadOnlyPostState();
await applicationVerificationRetriesTransientPostCaptureFailure();
await applicationVerificationCapsCaptureTimeoutToRemainingBudget();
await applicationVerificationCancellationPreservesCompletedDispatch();
await applicationVerificationLateCaptureFailureIsInconclusive();
await applicationCheckAlreadySatisfiedIsVerifiedNoop();
await applicationStateActionsRejectUnsupportedTargets();
await applicationStateActionsCannotWeakenDesiredStateExpectation();
await applicationStateActionLiveCapabilityDriftIsStale();
await applicationStateActionPartialDispatchStaysUnknown();
await applicationStateActionLastHopCapabilityLossIsStale();
await applicationFocusUnknownDispatchCanStillBeConfirmed();
await applicationMissingTargetFromTruncatedPostIsInconclusive();
await applicationKeystrokeUsesPidScopedUnicodeTransport();
await applicationKeyPressUsesPidScopedSpecialKeyTransport();
await applicationKeyPressUnknownDispatchIsNonReplayable();
await applicationSetValueUsesPrivateReadback();
await applicationDirectSetValueRetriesTransientReadback();
await applicationSetValueRetriesMissingPostBindingBeforeConsumingHandle();
await applicationSetValuePostCaptureFailureDiscardsRetainedValue();
await applicationSetValuePostProcessRelaunchSkipsReadback();
await applicationSetValueResourceAliasStaysInsideApplicationBackend();
await applicationSetValueMismatchIsNotObserved();
await applicationSetValueUnavailableReadbackIsUnknown();
await applicationDirectSetValueUnknownDispatchCanStillBeConfirmed();
await applicationResourceSetValueUnknownDispatchDoesNotReresolveAlias();
await applicationResourcePreDispatchTimeoutRemainsDefinite();
await arbitraryUnknownPhrasesRemainDefinite();
await applicationSetValueDoesNotVerifySiblingWindowTarget();
await applicationSetValueLiveSensitiveTargetDoesNotRetainResource();
await applicationSensitiveSetValueDoesNotForceReadback();
await applicationProcessRelaunchIsStaleBeforeSemanticDispatch();
await applicationSamePidGenerationChangeIsStaleBeforeSemanticDispatch();
await applicationActivateRelaunchIsStaleAtDispatch();
await applicationActivateSamePidGenerationChangeIsStaleAtDispatch();
await applicationPostProcessRelaunchCannotConfirmEffect();
await applicationPostSamePidGenerationChangeCannotConfirmEffect();
await applicationRefsAreSnapshotBoundAndVerified();
await applicationPostObservationCanBeFull();

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
await duplicateApplicationControlsUseOccurrenceIndex();
await applicationPostTargetRemovalDoesNotMap();
await applicationContinuationRejectsSiblingWindowIdentity();
await applicationContinuationRequiresSymmetricOwnerEvidence();
await applicationContinuationAllowsLayoutMovement();
await applicationOwnerWindowMigrationCountsAsSemanticChange();
await applicationRefGeometryDriftIsStale();
await applicationRefOwnerWindowDriftIsStale();
await applicationDispatchGeometryGuardMapsToStale();
await surfaceSpecificArgumentsAreRejected();
await snapshotStoreBoundaryMatrix();
await snapshotStoreIgnoresClockRollback();
await expiredSnapshotsCannotBeUsed();
console.log("computer use tests passed");

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
      include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    input_mode: "dom", include_post_screenshot: false,
  });
  await dispatchStarted;
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-lease" },
      input_mode: "dom", include_post_screenshot: false,
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
      input_mode: "dom", include_post_screenshot: false,
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
    include_post_screenshot: false,
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
  assert.equal(calls.some((entry) => entry.kind === "act"), false, "bound subframe ref unexpectedly fell back to the legacy browser action path");
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
    include_post_screenshot: false,
  });
  assert.equal(acted.dispatch.tab_metadata_verified, null,
    "legacy browser action without metadata verification evidence was not preserved as unknown");
  assert.equal(calls.some((entry) => entry.kind === "backend-act"), false,
    "daemon promoted a medium-confidence AX correlation into snapshot-bound trusted input");
  const legacy = calls.find((entry) => entry.kind === "act");
  assert.equal(Boolean(legacy), true,
    "medium-confidence ref did not fall back to the existing semantic ref action path");
  assert.equal(legacy.args.expected_ref_identity.role, "button");
  assert.equal(legacy.args.expected_ref_identity.name, "Continue");
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
      target: { ref: "e-frame-check-identity" }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false, input_mode: "auto",
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
      include_post_screenshot: false, input_mode: "trusted",
    }),
    (error) => error instanceof BridgeError && error.code === "unavailable" && error.details?.reason === "snapshot_backend_trusted_input_unavailable",
  );
  assert.equal(strictCalls.some((entry) => entry.kind === "act"), false, "explicit trusted mode silently fell back after backend geometry became unavailable");
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
    input_mode: "auto", include_post_screenshot: false,
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
    input_mode: "auto", wait_for: "complete", include_post_screenshot: false,
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
    input_mode: "dom", include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false, post_observation_detail: "full",
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
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-delta" }, include_post_screenshot: false,
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
    target: { ref: "e-identity-continuation" }, include_post_screenshot: false,
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
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-shared" }, include_post_screenshot: false,
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
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-child-reused" }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-missing" }, include_post_screenshot: false,
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
    expect: { semantic_change: true }, include_post_screenshot: false,
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
    expect: { text: "Done", url_changed: true }, include_post_screenshot: false,
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
    expect: { semantic_change: true }, include_post_screenshot: false,
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
    expect: { semantic_change: true }, include_post_screenshot: false,
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
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /mutually exclusive/.test(error.message),
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
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, include_post_screenshot: false }),
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
      surface: "browser", snapshot_id: coercibleUrlObserved.snapshot_id, action: "click", target: { ref: "e-live-url" }, include_post_screenshot: false,
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
      surface: "browser", snapshot_id: coercibleEpochObserved.snapshot_id, action: "click", target: { ref: "e-live-epoch" }, include_post_screenshot: false,
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
      surface: "browser", snapshot_id: coercibleIdentityObserved.snapshot_id, action: "click", target: { ref: "e-ref-identity" }, include_post_screenshot: false,
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
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e11" }, include_post_screenshot: false }),
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
      include_post_screenshot: false,
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
    include_post_screenshot: false,
  });
  assert.equal(acted.dispatch_status, "completed");
  const pointCall = calls.find((entry) => entry.kind === "point-act");
  assert.equal(pointCall.args.normalized_x, 0.5);
  assert.equal(pointCall.args.normalized_y, 0.25);
  assert.equal(pointCall.args.document_epoch, "doc-e-v1");
  assert.deepEqual(pointCall.args.viewport, { width: 800, height: 600, scale: 1 });
  assert.equal(pointCall.args.screenshot_sha256, "a".repeat(64));
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
      () => manager.act({ surface: "browser", snapshot_id: snapshotId, action: "click", target: { point }, include_post_screenshot: false }),
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
      target: { point: { x: 0.5, y: 0.25 } }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
  assert.equal(pointCalls[0].args.screenshot_sha256, "a".repeat(64));
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
    include_post_screenshot: false,
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
  assert.equal(pointCalls[0].args.screenshot_sha256, "a".repeat(64));
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    delta_x: 20, delta_y: 300, include_post_screenshot: false,
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
      include_post_screenshot: false,
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
        target: { point: { x: 0.2, y: 0.2 } }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
        target: { point: { x: 0.4, y: 0.4 } }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
      target: { point: { x: 0.4, y: 0.4 } }, include_post_screenshot: false,
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
      target: { point: { x: 0.5, y: 0.5 } }, include_post_screenshot: false,
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
    include_post_screenshot: false,
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
    include_post_screenshot: false,
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "successful event dispatch must not be promoted to business-effect success");
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.reason, "dispatch_completed_without_effect_contract");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.recovery, /Do not replay/i);
}

async function applicationFocusQueryRanksBoundedObservation() {
  const calls = [];
  const snapshot = appSnapshot(false, false);
  snapshot.elements = [
    { ...snapshot.elements[0], role: "AXButton", name: "Menu", identifier: "menu", focused: false },
    { ...snapshot.elements[0], role: "AXButton", name: "Save changes", identifier: "save", focused: false },
  ];
  const applications = appStub({ inspectQueue: [snapshot], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({
    surface: "application", application: "Notes", focus_query: "Save changes", max_elements: 1, include_screenshot: false,
  });
  assert.equal(observed.semantic.elements.length, 1);
  assert.equal(observed.semantic.elements[0].name, "Save changes");
  assert.equal(observed.semantic.selection.focus_query, "save changes");
  assert.equal(calls.find((entry) => entry.kind === "inspect-app").args.max_elements, 500, "focus query did not widen the bounded accessibility probe before ranking");
}

async function applicationObservationReturnsWindowScreenshot() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)],
    calls,
    screenshotResult: {
      screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
      window: { id: 901, bounds: { x: 10, y: 20, width: 640, height: 480 } },
    },
  });
  const manager = managerWith({ applications });
  const result = await manager.observe({ surface: "application", application: "Notes" });
  assert(result.$mcp, "application window screenshot must return native MCP image content");
  assert.equal(result.$mcp.content[1].type, "image");
  assert.equal(result.$mcp.structuredContent.capture.screenshot, true);
  assert.equal(result.$mcp.structuredContent.capture.screenshot_source, "macos_window");
  assert.equal(result.$mcp.structuredContent.capture.screenshot_sha256, PNG_A_SHA256);
  assert.equal(result.$mcp.structuredContent.capture.window_coherent, true);
  assert.equal(result.$mcp.structuredContent.capture.coherence, "window_screenshot_then_accessibility_window_stable");
  assert.equal(result.$mcp.structuredContent.capabilities.accessibility_geometry_coherent, true);
  assert.equal(result.$mcp.structuredContent.semantic.elements[0].ref, "a0");
  assert.deepEqual(calls.slice(0, 2).map((entry) => entry.kind), ["capture-app", "inspect-app"],
    "application observation did not bind the screenshot before AX or reused a separate post-AX window probe");
  assert.equal(calls.find((entry) => entry.kind === "inspect-app")?.args?.include_window_state, true,
    "application observation did not request post-AX window state from the existing Accessibility inspection");
  assert.equal(calls.some((entry) => entry.kind === "window-state"), false,
    "application observation launched a redundant post-AX window-state call despite inline revalidation");
}

async function oversizedApplicationScreenshotDegradesBeforeSnapshotPublication() {
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  const screenshot = bytes.toString("base64");
  const applications = appStub({
    inspectQueue: [appButtonSnapshot("Confirm", "confirm", { x: 100, y: 80, width: 120, height: 50 })],
    screenshotResult: {
      screenshot: { mime_type: "image/png", data: screenshot, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      window: { id: 902, bounds: { x: 0, y: 0, width: 400, height: 300 } },
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes" });
  assert.equal(observed.$mcp, undefined, "oversized screenshot still crossed the MCP result boundary as native image content");
  assert.match(observed.snapshot_id, /^cu_/);
  assert.equal(observed.capture.screenshot, false);
  assert.equal(observed.capture.screenshot_source, "none");
  assert.equal(observed.capture.screenshot_sha256, "");
  assert.equal(observed.capture.atomic, false, "omitting a returned image falsely converted a sequential capture into an atomic observation");
  assert.equal(observed.capture.window_coherent, true, "result-budget compaction discarded already-proven owner-window coherence");
  assert.equal(observed.capture.coherence, "window_screenshot_then_accessibility_image_omitted_for_result_budget");
  assert.match(observed.capture.screenshot_error, /result budget/);
  assert.equal(observed.capture.screenshot_omitted_reason, "tool_result_budget");
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, false);
  assert.equal(observed.capabilities.accessibility_geometry_coherent, true,
    "result-budget compaction weakened semantic ref window evidence together with pixel authority");
  assert.equal(manager.snapshots.items.size, 1, "result-budget downgrade failed to publish the still-usable semantic snapshot");
  const stored = manager.snapshots.items.get(observed.snapshot_id);
  assert(stored?.privateState?.application_window_binding, "semantic snapshot lost its private owner-window binding after image omission");
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "click",
      target: { point: { x: 0.5, y: 0.5 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
    "snapshot whose image was omitted retained pixel-click authority",
  );
}

async function oversizedPostScreenshotCompactsWithoutLosingContinuation() {
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  const screenshot = bytes.toString("base64");
  const applications = appStub({
    inspectQueue: [appSnapshot(true, false), appSnapshot(true, false), appSnapshot(true, true)],
    screenshotResult: {
      screenshot: { mime_type: "image/png", data: screenshot, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
      window: { id: 903, bounds: { x: 0, y: 0, width: 400, height: 300 } },
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
    post_screenshot: "always",
  });
  assert.equal(Boolean(acted.$mcp), false, "oversized post screenshot still crossed the MCP result boundary");
  assert.equal(acted.result_budget_compacted, true);
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.post_screenshot_included, false);
  assert.equal(acted.post_screenshot_omitted_reason, "tool_result_budget");
  assert.match(acted.post_snapshot_id || "", /^cu_/);
  assert.equal(acted.continuation?.available, true);
  assert.equal(acted.continuation?.snapshot_id, acted.post_snapshot_id);
  assert.equal(acted.retry_guidance?.same_action_retry_allowed, false);
  const stored = manager.snapshots.items.get(acted.post_snapshot_id);
  assert(stored, "result-budget compaction discarded the post snapshot needed for continuation");
  assert.equal(stored.observation.capture.screenshot, false);
  assert.match(stored.observation.capture.screenshot_error || "", /result budget/);
  assert.equal(stored.observation.capture.screenshot_omitted_reason, "tool_result_budget");
  assert(stored.privateState.application_window_binding, "result-budget compaction discarded post-snapshot window identity evidence");
}

async function applicationWindowChangeDuringObservationDisablesPointGeometry() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 61, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appButtonSnapshot("Confirm", "confirm", { x: 100, y: 80, width: 120, height: 50 })],
    screenshotResults: [shot],
    windowStateResults: [{ window: { id: 62, bounds: { x: 20, y: 20, width: 320, height: 220 } } }],
    calls,
  });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  assert.equal(observed.capture.screenshot, true, "window drift discarded the still-useful screenshot");
  assert.equal(observed.capture.window_coherent, false);
  assert.equal(observed.capture.coherence, "window_changed_during_capture");
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, false);
  assert.equal(observed.capabilities.accessibility_geometry, false, "window drift left falsely localized AX geometry actionable");
  assert.equal(observed.capabilities.accessibility_geometry_coherent, false);
  assert.equal(observed.semantic.elements[0].bounding_box, null);
  assert.equal(observed.semantic.elements[0].visible, null);
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.35 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false, "incoherent observation reached an input dispatcher");
}

async function applicationWindowRevalidationFailureIsExplicit() {
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 63, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appButtonSnapshot("Confirm", "confirm", { x: 100, y: 80, width: 120, height: 50 })],
    screenshotResults: [shot],
    windowStateError: new Error("Accessibility permission denied at /private/tmp/operator-secret"),
    inlineWindowState: false,
  });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  assert.equal(observed.capture.window_coherent, null);
  assert.equal(observed.capture.coherence, "window_screenshot_then_accessibility_unverified");
  assert.match(observed.capture.window_revalidation_error, /Accessibility permission may be required/);
  assert.equal(JSON.stringify(observed).includes("/private/tmp/operator-secret"), false, "window revalidation error leaked a private path");
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, false);
  assert.equal(observed.capabilities.accessibility_geometry, false);
  assert.equal(observed.semantic.elements[0].bounding_box, null);
}

async function cancelledApplicationWindowRevalidationDoesNotPublishSnapshot() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 64, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appButtonSnapshot("Confirm", "confirm", { x: 100, y: 80, width: 120, height: 50 }), appButtonSnapshot("Confirm", "confirm", { x: 100, y: 80, width: 120, height: 50 })],
    screenshotResults: [shot, shot],
    inlineWindowState: false,
    calls,
  });
  let windowChecks = 0;
  applications.inspectApplicationWindow = async (args) => {
    calls.push({ kind: "window-state", args });
    windowChecks += 1;
    if (windowChecks === 1) throw new BridgeError("cancelled", "computer observation cancelled during window revalidation");
    return { window: structuredClone(shot.window) };
  };
  let cancelled = true;
  const manager = managerWith({
    applications,
    throwIfCancelled() {
      if (cancelled && windowChecks > 0) {
        throw new BridgeError("cancelled", "computer observation cancelled before snapshot publication");
      }
    },
  });
  await assert.rejects(
    () => manager.observe({ surface: "application", application: "Notes" }),
    (error) => error instanceof BridgeError && error.code === "cancelled",
  );
  assert.equal(manager.snapshots.items.size, 0, "cancelled application observation published an actionable snapshot");
  cancelled = false;
  const recovered = await manager.observe({ surface: "application", application: "Notes" });
  assert.equal(recovered.$mcp.structuredContent.snapshot_id, "cu_test00000001",
    "cancelled application observation consumed a snapshot id before publication");
  assert.equal(manager.snapshots.items.size, 1, "successful application observation did not publish its snapshot after cancellation recovery");
}

async function applicationScreenshotFailureKeepsAccessibility() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)],
    screenshotError: new Error("Screen Recording permission denied at /private/tmp/operator-secret"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes" });
  assert.equal(observed.capture.screenshot, false);
  assert.equal(observed.capture.atomic, true);
  assert.equal(observed.capture.coherence, "accessibility_only_after_screenshot_failure");
  assert.equal(observed.capture.window_coherent, null);
  assert.match(observed.capture.screenshot_error, /Screen Recording permission may be required/);
  assert.equal(JSON.stringify(observed).includes("/private/tmp/operator-secret"), false, "application screenshot failure leaked a private path");
  assert.equal(observed.semantic.elements[0].ref, "a0", "screenshot failure discarded Accessibility state");
}

async function applicationPostActionDoesNotRepeatScreenshot() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
    calls,
    screenshotResult: { screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window" } },
  });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  const acted = await manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(calls.filter((entry) => entry.kind === "capture-app").length, 1, "application action repeated a screenshot during post-state capture");
  assert.equal(acted.post_observation.capture.screenshot_requested, false);
  assert.equal(acted.post_observation.capture.screenshot, false);
}

async function applicationVisualPointIsWindowAndScreenshotBound() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], calls, screenshotResults: [shot, shot],
  });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_visual_points, true);
  const actedResult = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click",
    target: { point: { x: 0.25, y: 0.75 } },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.post_screenshot_policy, "auto");
  assert.equal(acted.post_screenshot_included, true);
  assert.equal(actedResult.$mcp.content[1].type, "image");
  assert.equal(acted.dispatch.coordinate_source, "macos_skylight_experimental");
  assert.equal(acted.dispatch.window_bound, true);
  assert.equal(acted.dispatch.screenshot_revalidated, true);
  assert.equal(acted.dispatch.experimental_backend, true);
  assert.equal(acted.dispatch.focus_without_raise, true);
  assert.equal(acted.dispatch.front_window_validated, true);
  assert.equal(acted.dispatch.cursor_preserved, true);
  assert.deepEqual(acted.dispatch.normalized_point, { x: 0.25, y: 0.75 });
  const point = calls.find((entry) => entry.kind === "point-app");
  assert.equal(point.args.window_id, 321);
  assert.deepEqual(point.args.bounds, { x: 10, y: 20, width: 640, height: 480 });
  assert.equal(point.args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(calls.filter((entry) => entry.kind === "capture-app").length, 2, "kernel repeated screenshot preflight instead of leaving near-dispatch revalidation to AppAutomation");
}

async function applicationVisualPointRejectsCoercibleSnapshotAuthority() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], calls, screenshotResults: [shot] });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  for (const point of [
    { x: [0.25], y: 0.75 },
    { x: 0.25, y: 0.75, space: ["normalized_viewport"] },
  ]) {
    await assert.rejects(
      () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point } }),
      (error) => error instanceof BridgeError && error.code === "invalid_request",
    );
  }
  assert.equal(calls.some((entry) => entry.kind === "point-app"), false,
    "coercible application point target reached the native dispatcher");

  for (const malformedShot of [
    { ...structuredClone(shot), window: { ...structuredClone(shot.window), id: [321] } },
    { ...structuredClone(shot), window: { ...structuredClone(shot.window), bounds: { ...shot.window.bounds, width: [640] } } },
    { ...structuredClone(shot), screenshot: { ...structuredClone(shot.screenshot), source: ["macos_window"] } },
    { ...structuredClone(shot), screenshot: { ...structuredClone(shot.screenshot), data: [PNG_A_BASE64] } },
    { ...structuredClone(shot), screenshot: { ...structuredClone(shot.screenshot), data: "QUJD" } },
    { ...structuredClone(shot), screenshot: { ...structuredClone(shot.screenshot), data: `${PNG_A_BASE64}\n` } },
    { ...structuredClone(shot), screenshot: { ...structuredClone(shot.screenshot), mime_type: ["image/png"] } },
  ]) {
    const malformedCalls = [];
    const malformedApplications = appStub({
      inspectQueue: [appSnapshot(false, false)], calls: malformedCalls, screenshotResults: [malformedShot],
    });
    const malformedManager = managerWith({ applications: malformedApplications });
    const malformedResult = await malformedManager.observe({ surface: "application", application: "Notes" });
    const malformedObserved = malformedResult.$mcp?.structuredContent || malformedResult;
    assert.equal(malformedObserved.capabilities.snapshot_bound_visual_points, false,
      "coercible application window identity retained visual-point capability");
    await assert.rejects(
      () => malformedManager.act({
        surface: "application", snapshot_id: malformedObserved.snapshot_id, action: "click",
        target: { point: { x: 0.25, y: 0.75 } },
      }),
      (error) => error instanceof BridgeError && error.code === "conflict",
    );
    assert.equal(malformedCalls.some((entry) => entry.kind === "point-app"), false,
      "coercible application window identity reached the native dispatcher");
  }
}

async function applicationVisualDoubleClickIsSingleWindowBoundSettlement() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const semantic = appButtonSnapshot("Double", "double", { x: 100, y: 100, width: 160, height: 80 });
  const applications = appStub({ inspectQueue: [semantic, structuredClone(semantic)], calls, screenshotResults: [shot, shot] });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true, "fixture did not expose a semantic point candidate");
  const actedResult = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "double_click",
    target: { point: { x: 0.28, y: 0.3 } },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "double click without an explicit post-condition was promoted to effect success");
  const pointCalls = calls.filter((entry) => entry.kind === "point-app");
  assert.equal(pointCalls.length, 1, "application double click was split across multiple native settlements");
  assert.equal(pointCalls[0].args.click_count, 2);
  assert.equal(pointCalls[0].args.window_id, 321);
  assert.equal(pointCalls[0].args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(calls.some((entry) => entry.kind === "operate"), false,
    "application double click was approximated through one or more Accessibility clicks");
  assert.equal(acted.post_screenshot_included, true);
}

async function applicationVisualDoubleClickUnknownSettlementIsNotReplayed() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 322, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)],
    calls,
    screenshotResults: [shot, shot],
    pointApplicationError: new Error("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const acted = (await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "double_click",
    target: { point: { x: 0.35, y: 0.4 } }, post_screenshot: "always",
  })).$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(calls.filter((entry) => entry.kind === "point-app").length, 1,
    "ambiguous application double click was split or replayed through another point mutation");
  assert.equal(calls.find((entry) => entry.kind === "point-app").args.click_count, 2);
  assert.equal(calls.some((entry) => entry.kind === "operate"), false,
    "ambiguous application double click fell back to Accessibility after native settlement became unknown");
}

async function applicationVisualDoubleClickRejectsSemanticTarget() {
  const calls = [];
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "double_click", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "invalid_request"
      && /double_click requires a normalized point/.test(error.message),
  );
  assert.equal(calls.some((entry) => ["operate", "point-app", "drag-app", "scroll-app"].includes(entry.kind)), false,
    "semantic application double click reached an input dispatcher");
}

async function applicationHoverIsRejectedFailClosed() {
  const calls = [];
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes" });
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "hover",
      target: { point: { x: 0.5, y: 0.5 } },
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request"
      && error.message === "unsupported application computer action",
  );
  assert.equal(calls.some((entry) => ["operate", "point-app", "drag-app", "scroll-app"].includes(entry.kind)), false,
    "unsupported application hover reached an input dispatcher");
}

async function applicationVisualDragIsWindowAndScreenshotBound() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], calls, screenshotResults: [shot, shot],
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const actedResult = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "drag",
    target: { point: { x: 0.2, y: 0.25 } }, destination: { point: { x: 0.8, y: 0.75 } },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "application drag without an explicit post-condition was promoted to effect success");
  assert.equal(acted.dispatch.coordinate_source, "macos_skylight_experimental");
  assert.equal(acted.dispatch.window_bound, true);
  assert.equal(acted.dispatch.screenshot_revalidated, true);
  assert.equal(acted.dispatch.cursor_preserved, true);
  assert.deepEqual(acted.dispatch.normalized_point, { x: 0.2, y: 0.25 });
  assert.deepEqual(acted.dispatch.destination_normalized_point, { x: 0.8, y: 0.75 });
  const dragCalls = calls.filter((entry) => entry.kind === "drag-app");
  assert.equal(dragCalls.length, 1, "application drag was split or replayed through multiple native calls");
  assert.equal(dragCalls[0].args.window_id, 321);
  assert.deepEqual(dragCalls[0].args.bounds, { x: 10, y: 20, width: 640, height: 480 });
  assert.equal(dragCalls[0].args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "operate"), false,
    "application drag fell back to click or Accessibility input");
}

async function applicationVisualDragRequiresPixelBackend() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 71, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const initial = appButtonSnapshot("Handle", "handle", { x: 100, y: 90, width: 120, height: 60 });
  const applications = appStub({ inspectQueue: [initial], screenshotResults: [shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true, "fixture did not retain semantic point capability");
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "drag",
      target: { point: { x: 0.3, y: 0.4 } }, destination: { point: { x: 0.7, y: 0.4 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app" || entry.kind === "drag-app"), false,
    "application drag guessed an Accessibility fallback without a pixel backend");
}

async function applicationVisualDragUnknownDispatchReturnsEvidence() {
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 72, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const after = {
    screenshot: { mime_type: "image/png", data: PNG_B_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 72, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], screenshotResults: [before, after], calls,
    dragApplicationError: new Error("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const acted = (await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "drag",
    target: { point: { x: 0.25, y: 0.5 } }, destination: { point: { x: 0.75, y: 0.5 } },
  })).$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.post_screenshot_included, true);
  assert.match(acted.dispatch_error, /outcome is unknown/i);
  assert.equal(calls.filter((entry) => entry.kind === "drag-app").length, 1, "ambiguous application drag was replayed");
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "operate"), false,
    "ambiguous application drag fell back to another mutation path");
}

async function staleApplicationVisualDragIsRejectedBeforeDispatch() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 73, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot], calls,
    dragApplicationError: new Error("application visual snapshot changed before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "drag",
      target: { point: { x: 0.2, y: 0.3 } }, destination: { point: { x: 0.8, y: 0.7 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.filter((entry) => entry.kind === "drag-app").length, 1,
    "application drag did not delegate its final screenshot validation to AppAutomation exactly once");
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "operate"), false,
    "stale application drag fell back to another input path");
}

async function applicationVisualDragRejectsSemanticEndpoints() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 74, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot], calls });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "drag",
      target: { ref: "a0" }, destination: { ref: "a0" },
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request"
      && /application drag currently requires normalized point source and destination/.test(error.message),
  );
  assert.equal(calls.some((entry) => entry.kind === "drag-app" || entry.kind === "point-app" || entry.kind === "operate"), false,
    "application drag with semantic endpoints reached an input dispatcher");
}

async function applicationVisualScrollIsWindowAndScreenshotBound() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 10, y: 20, width: 640, height: 480 } },
    window: { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], calls, screenshotResults: [shot, shot],
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const acted = (await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "scroll",
    target: { point: { x: 0.35, y: 0.6 } }, delta_x: -120.4, delta_y: 640.6,
  })).$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "application scroll without an explicit post-condition was promoted to effect success");
  assert.equal(acted.dispatch.coordinate_source, "macos_skylight_experimental");
  assert.equal(acted.dispatch.window_bound, true);
  assert.equal(acted.dispatch.screenshot_revalidated, true);
  assert.equal(acted.dispatch.cursor_preserved, true);
  assert.deepEqual(acted.dispatch.normalized_point, { x: 0.35, y: 0.6 });
  assert.deepEqual(acted.dispatch.scroll_delta, { delta_x: -120, delta_y: 641 });
  const scrollCalls = calls.filter((entry) => entry.kind === "scroll-app");
  assert.equal(scrollCalls.length, 1, "application scroll was split or replayed through multiple native calls");
  assert.equal(scrollCalls[0].args.window_id, 321);
  assert.equal(scrollCalls[0].args.delta_x, -120.4);
  assert.equal(scrollCalls[0].args.delta_y, 640.6);
  assert.equal(scrollCalls[0].args.screenshot_sha256, PNG_A_SHA256);
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "operate" || entry.kind === "drag-app"), false,
    "application scroll fell back to click, drag, or Accessibility input");
}

async function applicationVisualScrollRequiresPixelBackend() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 75, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const initial = appButtonSnapshot("Scrollable", "scrollable", { x: 80, y: 60, width: 240, height: 180 });
  const applications = appStub({ inspectQueue: [initial], screenshotResults: [shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true);
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "scroll",
      target: { point: { x: 0.5, y: 0.5 } }, delta_y: 500,
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app" || entry.kind === "drag-app" || entry.kind === "scroll-app"), false,
    "application scroll guessed a semantic fallback without a pixel backend");
}

async function applicationVisualScrollUnknownDispatchReturnsEvidence() {
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 76, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const after = {
    screenshot: { mime_type: "image/png", data: PNG_B_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 76, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], screenshotResults: [before, after], calls,
    scrollApplicationError: new Error("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const acted = (await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "scroll",
    target: { point: { x: 0.5, y: 0.5 } }, delta_y: 600,
  })).$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.post_screenshot_included, true);
  assert.match(acted.dispatch_error, /outcome is unknown/i);
  assert.equal(calls.filter((entry) => entry.kind === "scroll-app").length, 1, "ambiguous application scroll was replayed");
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "drag-app" || entry.kind === "operate"), false,
    "ambiguous application scroll fell back to another mutation path");
}

async function staleApplicationVisualScrollIsRejectedBeforeDispatch() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 77, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot], calls,
    scrollApplicationError: new Error("application visual snapshot changed before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "scroll",
      target: { point: { x: 0.5, y: 0.5 } }, delta_y: 500,
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.filter((entry) => entry.kind === "scroll-app").length, 1,
    "application scroll did not delegate final screenshot validation to AppAutomation exactly once");
  assert.equal(calls.some((entry) => entry.kind === "point-app" || entry.kind === "drag-app" || entry.kind === "operate"), false,
    "stale application scroll fell back to another input path");
}

async function applicationVisualScrollRejectsSemanticAnchor() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 78, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot], calls });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "scroll", target: { ref: "a0" }, delta_y: 500,
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request"
      && /application scroll requires a normalized point anchor/.test(error.message),
  );
  assert.equal(calls.some((entry) => entry.kind === "scroll-app" || entry.kind === "point-app" || entry.kind === "drag-app" || entry.kind === "operate"), false,
    "application scroll with semantic anchor reached an input dispatcher");
}

async function applicationVisualPointReportsSemanticCandidates() {
  const calls = [];
  const snapshot = appSnapshot(false, false);
  snapshot.elements = [
    { ...snapshot.elements[0], role: "AXStaticText", name: "Confirm", identifier: "confirm", screen_box: { x: 110, y: 220, width: 100, height: 50 } },
    { ...snapshot.elements[0], role: "AXGroup", name: "Dialog", identifier: "dialog", screen_box: { x: 100, y: 200, width: 400, height: 300 } },
  ];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 100, y: 200, width: 400, height: 300 } },
    window: { id: 333, bounds: { x: 100, y: 200, width: 400, height: 300 } },
  };
  const applications = appStub({ inspectQueue: [snapshot, structuredClone(snapshot)], calls, screenshotResults: [shot, shot] });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const confirmRef = observed.semantic.elements.find((element) => element.name === "Confirm")?.ref;
  const acted = (await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.1, y: 0.1 } },
  })).$mcp.structuredContent;
  assert.equal(acted.dispatch.semantic_point_candidates.length, 2);
  assert.equal(acted.dispatch.semantic_point_candidates[0].name, "Confirm", "semantic point provenance did not prefer the smallest containing AX region");
  assert.equal(acted.dispatch.semantic_point_candidates[0].ref, confirmRef);
  assert.deepEqual(acted.dispatch.semantic_point_candidates[0].bounding_box, { x: 10, y: 20, width: 100, height: 50 });
  assert.equal(acted.dispatch.semantic_point_candidates[1].name, "Dialog");
}

async function applicationVisualChangeCanConfirmEffect() {
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 22, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const after = {
    screenshot: { mime_type: "image/png", data: PNG_B_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 22, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], screenshotResults: [before, after],
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const actedResult = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.5, y: 0.5 } },
    expect: { visual_change: true },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.observed_diff.screenshot_changed, true);
  assert.equal(acted.verification.post_checks[0].condition, "visual_change");
  assert.equal(acted.verification.post_checks[0].evidence_source, "screenshot");
  assert.equal(acted.verification.post_checks[0].observed, true);
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
}

async function applicationVisualUnknownDispatchReturnsEvidence() {
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 23, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const after = {
    screenshot: { mime_type: "image/png", data: PNG_B_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 23, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], screenshotResults: [before, after],
    pointApplicationError: new Error("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  const actedResult = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.6 } },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.post_screenshot_included, true);
  assert.equal(actedResult.$mcp.content[1].type, "image");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.retry_guidance.disposition, "use_post_snapshot");
  assert.match(acted.dispatch_error, /outcome is unknown/i);
}

async function staleApplicationVisualPointIsRejectedBeforeDispatch() {
  const calls = [];
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 11, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)], calls, screenshotResults: [before],
    pointApplicationError: new Error("application visual snapshot changed before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.5, y: 0.5 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.filter((entry) => entry.kind === "point-app").length, 1, "kernel did not delegate near-dispatch screenshot validation to AppAutomation");
}

async function applicationWithoutWindowScreenshotRejectsVisualPoint() {
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)] });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.5, y: 0.5 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
}

async function applicationDisabledBackendDoesNotExposeVisualPoint() {
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 41, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot] });
  applications.visualPointCapability = () => ({ available: false, configured: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capture.screenshot, true);
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false, "window screenshot incorrectly enabled a disabled background pixel backend");
  assert.equal(observed.capabilities.visual_point_backend, "disabled");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.5, y: 0.5 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
}

async function applicationFailedProbeKeepsScreenshotButRejectsVisualPoint() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 42, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)], screenshotResults: [shot], calls });
  applications.visualPointCapability = () => ({
    available: false,
    configured: true,
    probed: true,
    backend: "skylight-experimental",
    experimental: true,
    non_disruptive_intent: true,
    error_class: "helper_probe_failed_before_dispatch",
  });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  assert.equal(observed.capture.screenshot, true, "failed visual backend probe discarded the application screenshot");
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  assert.equal(observed.capabilities.visual_point_backend, "skylight-experimental");
  assert.equal(observed.capabilities.visual_point_configured, true);
  assert.equal(observed.capabilities.visual_point_probed, true);
  assert.equal(observed.capabilities.visual_point_error_class, "helper_probe_failed_before_dispatch");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.5, y: 0.5 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "point-app"), false, "failed backend probe still reached application visual dispatch");
}

async function applicationSemanticPointUsesAccessibilityWithoutPixelBackend() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 51, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 60 });
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  const applications = appStub({
    inspectQueue: [initial, preflight, post],
    screenshotResults: [shot, shot, shot],
    calls,
  });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observedResult = await manager.observe({ surface: "application", application: "Notes" });
  const observed = observedResult.$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_visual_points, false);
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true, "addressable AX geometry was not advertised as semantic point delivery");
  const actedResult = await manager.act({
    surface: "application",
    snapshot_id: observed.snapshot_id,
    action: "click",
    target: { point: { x: 0.4, y: 0.4 } },
  });
  const acted = actedResult.$mcp.structuredContent;
  assert.equal(acted.dispatch.coordinate_source, "accessibility_point_resolution");
  assert.equal(acted.dispatch.window_bound, true);
  assert.equal(acted.dispatch.screenshot_revalidated, true);
  assert.equal(acted.dispatch.experimental_backend, false);
  assert.equal(acted.dispatch.semantic_point_candidates[0].ref, "a0");
  const semanticDispatch = calls.find((entry) => entry.kind === "operate");
  assert.deepEqual(semanticDispatch.args.selector, { identifier: "save" });
  assert.deepEqual(semanticDispatch.args.expected_window_bounds, { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(semanticDispatch.args.expected_element_bounds, { x: 100, y: 90, width: 120, height: 60 });
  assert.equal(calls.some((entry) => entry.kind === "point-app"), false, "AX-resolvable visual point unnecessarily entered the private pixel backend");
  assert.equal(calls.filter((entry) => entry.kind === "capture-app").length, 3, "semantic visual point did not revalidate the screenshot and return post visual evidence");
}

async function truncatedApplicationObservationDoesNotClaimSemanticPointUniqueness() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 511, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const snapshot = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 60 });
  snapshot.elements.push({
    ...snapshot.elements[0],
    index: 1,
    name: "Outside budget",
    identifier: "outside-budget",
    screen_box: { x: 260, y: 200, width: 80, height: 40 },
  });
  const applications = appStub({ inspectQueue: [snapshot], screenshotResults: [shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({
    surface: "application", application: "Notes", max_elements: 1,
  })).$mcp.structuredContent;
  assert.equal(observed.semantic.truncated, true);
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, false,
    "truncated Accessibility projection claimed point uniqueness from an incomplete candidate set");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.4 } } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false);
}

async function ambiguousApplicationSemanticPointDoesNotGuess() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 52, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const snapshot = appButtonSnapshot("Primary", "primary", { x: 100, y: 90, width: 140, height: 70 });
  snapshot.elements.push({
    ...snapshot.elements[0],
    index: 1,
    name: "Overlay",
    identifier: "overlay",
    screen_box: { x: 120, y: 100, width: 100, height: 50 },
  });
  const applications = appStub({ inspectQueue: [snapshot], screenshotResults: [shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true);
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.4 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "application_visual_snapshot_not_actionable",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false, "ambiguous AX point guessed a delivery target");
}

async function semanticPointRejectsNewLiveOverlap() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 521, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 60 });
  const changed = structuredClone(initial);
  changed.elements.push({
    ...changed.elements[0],
    index: 1,
    name: "Late overlay",
    identifier: "late-overlay",
    screen_box: { x: 130, y: 100, width: 80, height: 40 },
  });
  const applications = appStub({ inspectQueue: [initial, changed], screenshotResults: [shot, shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  assert.equal(observed.capabilities.snapshot_bound_semantic_points, true);
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.4 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false,
    "semantic point ignored a newly overlapping live Accessibility target");
}

async function semanticPointRejectsIncompleteLiveCoverage() {
  const calls = [];
  const shot = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 522, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 60 });
  const incomplete = structuredClone(initial);
  incomplete.truncated = true;
  const applications = appStub({ inspectQueue: [initial, incomplete], screenshotResults: [shot, shot], calls });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.4 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false,
    "semantic point dispatched after live Accessibility coverage became incomplete");
}

async function staleApplicationSemanticPointScreenshotRejectsBeforeAccessibilityDispatch() {
  const calls = [];
  const before = {
    screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 53, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const changed = {
    screenshot: { mime_type: "image/png", data: PNG_B_BASE64, source: "macos_window", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    window: { id: 53, bounds: { x: 0, y: 0, width: 400, height: 300 } },
  };
  const applications = appStub({
    inspectQueue: [appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 60 })],
    screenshotResults: [before, changed],
    calls,
  });
  applications.visualPointCapability = () => ({ available: false, configured: false, probed: false, backend: "disabled", experimental: false });
  const manager = managerWith({ applications });
  const observed = (await manager.observe({ surface: "application", application: "Notes" })).$mcp.structuredContent;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { point: { x: 0.4, y: 0.4 } },
    }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate" || entry.kind === "point-app"), false, "changed screenshot reached semantic or pixel dispatch");
}

async function applicationCheckboxClickUsesIntrinsicReadback() {
  const calls = [];
  const initial = appCheckboxSnapshot(false);
  const preflight = appCheckboxSnapshot(false);
  const post = appCheckboxSnapshot(true);
  const applications = appStub({ inspectQueue: [initial, preflight, post], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  assert.equal(observed.semantic.elements[0].checked, false);
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed", "checkbox AXPress was not confirmed by post-state readback");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_checked", matched: true, evidence_source: "application_accessibility" }]);
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 1);
  assert.deepEqual(acted.observed_diff.semantic_delta.changed[0].changed_fields, ["checked"]);
  assert.equal(acted.post_observation.semantic.elements[0].checked, true, "compact application post state dropped checked readback");
}

async function applicationCheckboxNoopIsNotObserved() {
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(false), appCheckboxSnapshot(false), appCheckboxSnapshot(false)],
    repeatLastInspect: true,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "not_observed", "successful AXPress without checkbox state change was promoted to effect success");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_checked", matched: false, evidence_source: "application_accessibility" }]);
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.retry_guidance.disposition, "use_post_snapshot");
  assert.equal(acted.retry_guidance.mapped_post_target_ref, "a0", "recovery omitted the safe post-snapshot mapping for replanning");
  assert.equal(acted.retry_guidance.mapped_ref_for_replanning_only, true, "mapped ref was not explicitly constrained to replanning");
}

async function applicationExplicitSelectionExpectationUsesReadback() {
  const initial = appButtonSnapshot("Row", "row", null);
  initial.elements[0].role = "AXRow";
  initial.elements[0].selected = false;
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].selected = true;
  const applications = appStub({ inspectQueue: [initial, preflight, post] });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "a0" },
    expect: { target_selected: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_selected", matched: true, evidence_source: "application_accessibility" }]);
}

async function applicationCheckAndUncheckUseDesiredStateReadback() {
  const checkCalls = [];
  const checkApplications = appStub({
    inspectQueue: [appCheckboxSnapshot(false), appCheckboxSnapshot(false), appCheckboxSnapshot(true)],
    calls: checkCalls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: false, checked_after: true,
    },
  });
  const checkManager = managerWith({ applications: checkApplications });
  const checkedSnapshot = await checkManager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const checked = await checkManager.act({
    surface: "application", snapshot_id: checkedSnapshot.snapshot_id, action: "check", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(checked.effect_status, "confirmed");
  assert.deepEqual(checked.verification.post_checks, [{ condition: "target_checked", matched: true, evidence_source: "application_accessibility" }]);
  assert.equal(checked.dispatch.no_input_required, false);
  assert.equal(checked.dispatch.checked_before, false);
  assert.equal(checked.dispatch.checked_after, true);
  assert.equal(checkCalls.find((entry) => entry.kind === "operate").args.action, "check");

  const uncheckCalls = [];
  const uncheckApplications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(false)],
    calls: uncheckCalls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const uncheckManager = managerWith({ applications: uncheckApplications });
  const uncheckedSnapshot = await uncheckManager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const unchecked = await uncheckManager.act({
    surface: "application", snapshot_id: uncheckedSnapshot.snapshot_id, action: "uncheck", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(unchecked.effect_status, "confirmed");
  assert.deepEqual(unchecked.verification.post_checks, [{ condition: "target_checked", matched: true, evidence_source: "application_accessibility" }]);
  assert.equal(unchecked.dispatch.checked_before, true);
  assert.equal(unchecked.dispatch.checked_after, false);
  assert.equal(uncheckCalls.find((entry) => entry.kind === "operate").args.action, "uncheck");
}

async function applicationVerificationPollsReadOnlyPostState() {
  const calls = [];
  let clock = 1000;
  const sleeps = [];
  const applications = appStub({
    inspectQueue: [
      appCheckboxSnapshot(true),
      appCheckboxSnapshot(true),
      appCheckboxSnapshot(true),
      appCheckboxSnapshot(false),
    ],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const manager = managerWith({
    applications,
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
  });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "uncheck", target: { ref: "a0" },
    post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.effect_status, "confirmed", "read-only post-state polling did not observe the settled checkbox state");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "application verification replayed the mutation");
  assert.equal(calls.filter((entry) => entry.kind === "inspect-app").length, 4, "application verification did not perform exactly one bounded read-only retry");
  assert.equal(sleeps.length, 1);
  assert.equal(acted.post_snapshot_id, "cu_test00000003", "final continuation did not use the settled post snapshot");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: "cu_test00000002", action: "check", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
}

async function applicationVerificationRetriesTransientPostCaptureFailure() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(false)],
    inspectErrors: [null, null, new Error("transient Accessibility post readback failure"), null],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "uncheck", target: { ref: "a0" },
    post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.effect_status, "confirmed", "transient post-capture failure escaped the bounded read-only verifier retry");
  assert.equal(Object.hasOwn(acted, "post_observation_error"), false, "recovered transient post-capture failure leaked as a final error");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "post-capture recovery replayed the application mutation");
  assert.equal(calls.filter((entry) => entry.kind === "inspect-app").length, 4, "post-capture recovery did not retry the read-only observation exactly once");
}

async function applicationVerificationCapsCaptureTimeoutToRemainingBudget() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(false)],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "uncheck", target: { ref: "a0" },
    post_screenshot: "never", timeout_seconds: 30, verify_timeout_seconds: 1,
  });
  assert.equal(acted.effect_status, "confirmed");
  const inspectCalls = calls.filter((entry) => entry.kind === "inspect-app");
  assert.deepEqual(inspectCalls.slice(-2).map((entry) => entry.args.timeout_seconds), [30, 1],
    "application verifier did not preserve the normal first post-capture timeout and cap only the retry to remaining verification budget");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1);
}

async function applicationVerificationCancellationPreservesCompletedDispatch() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true)],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const manager = managerWith({
    applications,
    throwIfCancelled() {
      if (calls.some((entry) => entry.kind === "operate")) {
        throw new BridgeError("cancelled", "application post-verification cancelled after dispatch at /private/tmp/operator-secret");
      }
    },
  });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "uncheck", target: { ref: "a0" },
    post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.dispatch_status, "completed", "post-dispatch verification cancellation overwrote completed application dispatch");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.post_snapshot_id, null);
  assert.match(acted.post_observation_error, /application post observation unavailable \(error_class=cancelled\)/);
  assert.equal(acted.post_observation_error.includes("/private/tmp/operator-secret"), false,
    "application verification cancellation leaked lower-layer private error detail");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false,
    "post-dispatch verification cancellation made an already-issued mutation retryable");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "verification cancellation replayed application input");
  assert.equal(manager.snapshots.items.size, 0, "verification cancellation retained the consumed pre-dispatch snapshot or published an internal post snapshot");
}

async function applicationVerificationLateCaptureFailureIsInconclusive() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(true)],
    inspectErrors: [null, null, null, new Error("later Accessibility verification read failed")],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: false, checked_before: true, checked_after: false,
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "uncheck", target: { ref: "a0" },
    post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown",
    "a stale early post snapshot was treated as definitive after later verification captures became unavailable");
  assert.equal(acted.verification.inconclusive, true);
  assert.match(acted.post_observation_error, /application post observation unavailable \(error_class=execution_failed\)/);
  assert.match(acted.post_snapshot_id || "", /^cu_/, "last valid post snapshot was not retained as continuation evidence");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "late verification failure replayed application input");
}

async function applicationCheckAlreadySatisfiedIsVerifiedNoop() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(true), appCheckboxSnapshot(true), appCheckboxSnapshot(true)],
    calls,
    operateApplicationResult: {
      ok: true, matched: 1, selected_index: 0, no_input_required: true, checked_before: true, checked_after: true,
    },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch.no_input_required, true);
  assert.equal(acted.dispatch.checked_before, true);
  assert.equal(acted.dispatch.checked_after, true);
  assert.equal(acted.effect_status, "confirmed", "already-satisfied check was not verified through post-state readback");
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 0);
}

async function applicationStateActionsRejectUnsupportedTargets() {
  const textCalls = [];
  const textManager = managerWith({ applications: appStub({ inspectQueue: [appSnapshot(false, false)], calls: textCalls }) });
  const textObserved = await textManager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => textManager.act({ surface: "application", snapshot_id: textObserved.snapshot_id, action: "check", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /checkbox or radio button/.test(error.message),
  );
  assert.equal(textCalls.some((entry) => entry.kind === "operate"), false);

  const radio = appCheckboxSnapshot(true);
  radio.elements[0].role = "AXRadioButton";
  const radioCalls = [];
  const radioManager = managerWith({ applications: appStub({ inspectQueue: [radio], calls: radioCalls }) });
  const radioObserved = await radioManager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => radioManager.act({ surface: "application", snapshot_id: radioObserved.snapshot_id, action: "uncheck", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /checkbox target/.test(error.message),
  );
  assert.equal(radioCalls.some((entry) => entry.kind === "operate"), false);
}

async function applicationStateActionsCannotWeakenDesiredStateExpectation() {
  const calls = [];
  const manager = managerWith({ applications: appStub({ inspectQueue: [appCheckboxSnapshot(false)], calls }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "a0" },
      expect: { target_checked: false },
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /requires expect\.target_checked=true/.test(error.message),
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false, "contradictory check expectation reached application dispatch");

  const browserCalls = [];
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/check-contract", "e-check-contract")], calls: browserCalls });
  const browserManager = managerWith({ browser });
  const browserObserved = await browserManager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => browserManager.act({
      surface: "browser", snapshot_id: browserObserved.snapshot_id, action: "check", target: { ref: "e-check-contract" },
      expect: { target_state: "unchecked" }, include_post_screenshot: false,
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /requires expect\.target_state=checked/.test(error.message),
  );
  assert.equal(browserCalls.some((entry) => entry.kind === "backend-act" || entry.kind === "act"), false, "contradictory browser check expectation reached dispatch");
}

async function applicationStateActionLiveCapabilityDriftIsStale() {
  const calls = [];
  const drifted = appCheckboxSnapshot(false);
  drifted.elements[0].checked = null;
  const applications = appStub({ inspectQueue: [appCheckboxSnapshot(false), drifted], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false, "lost live checked-state capability reached dispatch");
}

async function applicationStateActionPartialDispatchStaysUnknown() {
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(false), appCheckboxSnapshot(false), appCheckboxSnapshot(false)],
    operateApplicationError: new Error("application checked-state input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.match(acted.dispatch_error, /outcome is unknown/i);
}

async function applicationStateActionLastHopCapabilityLossIsStale() {
  const applications = appStub({
    inspectQueue: [appCheckboxSnapshot(false), appCheckboxSnapshot(false)],
    operateApplicationError: new Error("application target checked state is unavailable before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
}

async function applicationFocusUnknownDispatchCanStillBeConfirmed() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
    operateApplicationError: new Error("application Accessibility input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "confirmed", "post-state focus readback did not override ambiguous dispatch certainty");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_focused", matched: true, evidence_source: "application_accessibility" }]);
  assert.equal(acted.retry_guidance.disposition, "do_not_retry");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function applicationMissingTargetFromTruncatedPostIsInconclusive() {
  const before = appSnapshot(false, false);
  const preflight = appSnapshot(false, false);
  const after = appSnapshot(false, false);
  after.elements = [];
  after.truncated = true;
  const applications = appStub({ inspectQueue: [before, preflight, after] });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown",
    "truncated post Accessibility coverage turned target omission into definite mutation evidence");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "target_focused")?.reason,
    "post_target_coverage_incomplete");
}

async function applicationKeystrokeUsesPidScopedUnicodeTransport() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
    calls,
    operateApplicationResult: { ok: true, matched: 1, selected_index: 0, input_transport: "public-cgevent-pid", focus_prepared: true },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const callsBeforeInvalidKeystrokes = calls.length;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "keystroke", target: { ref: "a0" },
      value: "", post_screenshot: "never",
    }),
    /application keystroke requires non-empty text/,
  );
  assert.equal(calls.length, callsBeforeInvalidKeystrokes, "empty Computer Use keystroke reached application preflight or dispatch");
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "keystroke", target: { ref: "a0" },
      value: "中文😀x", expect: { target_focused: false }, post_screenshot: "never",
    }),
    /application keystroke requires expect\.target_focused=true/,
  );
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "keystroke", target: { ref: "a0" },
    value: "中文😀x", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.dispatch.input_transport, "public-cgevent-pid", "Computer Use dropped PID-scoped application keyboard provenance");
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.equal(dispatch?.args?.action, "keystroke");
  assert.equal(dispatch?.args?.value, "中文😀x");
  assert.equal(dispatch?.args?.expected_process_id, 7001);
  assert.equal(dispatch?.args?.expected_process_generation, "gen-7001");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_focused", matched: true, evidence_source: "application_accessibility" }]);
}

async function applicationKeyPressUsesPidScopedSpecialKeyTransport() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
    calls,
    operateApplicationResult: { ok: true, matched: 1, selected_index: 0, input_transport: "public-cgevent-pid", focus_prepared: true },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "key_press", target: { ref: "a0" },
    key: "Shift+Tab", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "key_press incorrectly inferred a stable post-focus effect from pre-dispatch focus preparation");
  assert.equal(acted.dispatch.input_transport, "public-cgevent-pid", "Computer Use dropped PID-scoped special-key provenance");
  assert.equal(acted.dispatch.focus_prepared, true, "Computer Use dropped pre-dispatch AX focus provenance for key_press");
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.equal(dispatch?.args?.action, "key_press");
  assert.equal(dispatch?.args?.key, "Shift+Tab");
  assert.equal(dispatch?.args?.expected_process_id, 7001);
  assert.equal(dispatch?.args?.expected_process_generation, "gen-7001");
  assert.deepEqual(acted.verification.post_checks ?? [], []);
}

async function applicationKeyPressUnknownDispatchIsNonReplayable() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    operateApplicationError: new Error("application key_press may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "key_press", target: { ref: "a0" },
    key: "Enter", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false,
    "ambiguous native key_press was advertised as replayable");
  assert.match(acted.dispatch_error, /outcome is unknown/i);
}

async function applicationSetValueUsesPrivateReadback() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    calls,
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "hello", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed", "non-sensitive set_value was not confirmed by private AXValue comparison");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_value_matches", matched: true, observed: true, evidence_source: "application_accessibility" }]);
  const verify = calls.find((entry) => entry.kind === "verify-value");
  assert.equal(verify.args.value_verification_handle, undefined, "immutable direct value unnecessarily entered retained-value storage");
  assert.equal(verify.args.value, "hello", "direct set_value did not reuse the exact immutable request value for readback");
  assert.equal(verify.args.value_resource, undefined);
  assert.equal(Object.hasOwn(acted.dispatch, "_machine_value_verification_handle"), false, "private application value handle leaked into Computer Use dispatch output");
  assert.equal(calls.some((entry) => entry.kind === "discard-value"), false,
    "immutable direct set_value created retained-value cleanup state it does not need");
}

async function applicationDirectSetValueRetriesTransientReadback() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    calls,
  });
  let verifyAttempts = 0;
  applications.verifyApplicationValue = async (args) => {
    calls.push({ kind: "verify-value", args });
    verifyAttempts += 1;
    if (verifyAttempts === 1) throw new Error("transient read-only AX verification transport failure");
    return { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" };
  };
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
    value: "retry-safe-direct-value", post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.effect_status, "confirmed", "immutable direct set_value did not recover from a transient read-only verification failure");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "set_value mutation was replayed while retrying read-only verification");
  assert.equal(calls.filter((entry) => entry.kind === "verify-value").length, 2, "direct exact-value verification did not retry exactly once after a transient failure");
  for (const call of calls.filter((entry) => entry.kind === "verify-value")) {
    assert.equal(call.args.value, "retry-safe-direct-value");
    assert.equal(call.args.value_verification_handle, undefined);
    assert.equal(call.args.timeout_seconds, 1,
      "direct exact-value readback escaped the remaining verify_timeout_seconds budget");
  }
  assert.equal(calls.some((entry) => entry.kind === "discard-value"), false,
    "retry-safe direct value unexpectedly allocated retained secret state");
}

async function applicationSetValueRetriesMissingPostBindingBeforeConsumingHandle() {
  const calls = [];
  const missingPostTarget = appSnapshot(false, false);
  missingPostTarget.elements = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), missingPostTarget, appSnapshot(false, false)],
    calls,
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
    value_resource: "account-secret", post_screenshot: "never", verify_timeout_seconds: 1,
  });
  assert.equal(acted.effect_status, "confirmed", "post-target binding retry did not reach exact-value verification");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1, "set_value was replayed while waiting for a post binding");
  assert.equal(calls.filter((entry) => entry.kind === "verify-value").length, 1, "one-shot exact-value handle was consumed more than once");
  assert.equal(calls.filter((entry) => entry.kind === "discard-value").length, 1, "one-shot exact-value handle cleanup was not idempotent");
  assert.equal(acted.post_snapshot_id, "cu_test00000003", "set_value did not retain the post snapshot whose binding was actually verified");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: "cu_test00000002", action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
}

async function applicationSetValuePostCaptureFailureDiscardsRetainedValue() {
  const calls = [];
  const applications = appStub({ inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
    value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown");
  assert.match(acted.post_observation_error, /application post observation unavailable \(error_class=execution_failed\)/);
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false, "value readback unexpectedly ran without a post snapshot");
  const discarded = calls.find((entry) => entry.kind === "discard-value");
  assert.match(discarded?.handle || "", /^av_[A-Za-z0-9_-]{24,80}$/, "post-capture failure left the retained exact value waiting for TTL cleanup");
  assert.equal(Object.hasOwn(acted.dispatch, "_machine_value_verification_handle"), false);
}

async function applicationSetValuePostProcessRelaunchSkipsReadback() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const preflight = structuredClone(initial);
  const relaunchedPost = structuredClone(initial);
  const applications = appStub({
    inspectQueue: [initial, preflight, relaunchedPost],
    processIds: [7001, 7001, 7002],
    calls,
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
    value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "not_observed");
  assert.equal(acted.observed_diff.process_changed, true);
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false,
    "exact value from the old application process was compared against a relaunched process");
  assert.equal(calls.some((entry) => entry.kind === "discard-value"), true,
    "relaunch path did not release the old process exact-value handle");
}

async function applicationSetValueResourceAliasStaysInsideApplicationBackend() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    calls,
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  const dispatch = calls.find((entry) => entry.kind === "operate");
  const verify = calls.find((entry) => entry.kind === "verify-value");
  assert.equal(dispatch.args.value_resource, "account-secret");
  assert.equal(dispatch.args.value, undefined);
  assert.match(verify.args.value_verification_handle, /^av_[A-Za-z0-9_-]{24,80}$/, "Computer Use did not use the retained exact-value handle for resource verification");
  assert.equal(verify.args.value_resource, undefined, "Computer Use re-resolved the secret alias during verification instead of using the retained exact value");
  assert.equal(verify.args.value, undefined);
}

async function applicationSetValueMismatchIsNotObserved() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    verifyApplicationValueResult: { supported: true, matched: false, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "hello", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "not_observed", "set_value mismatch was promoted to effect success");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_value_matches", matched: false, observed: false, evidence_source: "application_accessibility" }]);
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function applicationSetValueUnavailableReadbackIsUnknown() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    verifyApplicationValueError: new Error("fixture readback unavailable at /private/tmp/secret"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "hello", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "unknown", "unavailable set_value readback was misclassified as a definite failure");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks[0].observed, null);
  assert.equal(JSON.stringify(acted).includes("/private/tmp/secret"), false, "value readback failure leaked backend detail");
}

async function applicationDirectSetValueUnknownDispatchCanStillBeConfirmed() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    operateApplicationError: new Error("application value input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "immutable-request-value", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "confirmed", "direct immutable value could not confirm an ambiguous AXValue assignment by readback");
  assert.equal(acted.verification.post_checks[0].matched, true);
}

async function applicationResourceSetValueUnknownDispatchDoesNotReresolveAlias() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    calls,
    operateApplicationError: new Error("application value input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying."),
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "unknown");
  assert.equal(acted.effect_status, "unknown", "resource-backed ambiguous write was confirmed without the exact dispatched value handle");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks[0].reason, "exact_dispatched_resource_value_unavailable");
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false, "ambiguous resource write re-resolved the alias during verification");
}

async function applicationResourcePreDispatchTimeoutRemainsDefinite() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
    operateApplicationError: new Error("registered resource read timed out before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
      value_resource: "account-secret", post_screenshot: "never",
    }),
    /registered resource read timed out before dispatch/,
    "pre-dispatch resource timeout was misclassified as an ambiguous application mutation",
  );
}

async function arbitraryUnknownPhrasesRemainDefinite() {
  {
    const before = browserSnapshot("https://example.test/preflight-phrase", "e-preflight", "doc-preflight");
    const browser = browserStub({
      inspectQueue: [before],
      actError: new Error("browser preflight outcome is unknown before dispatch"),
    });
    const manager = managerWith({ browser });
    const observed = await manager.observe({ surface: "browser", include_screenshot: false });
    await assert.rejects(
      () => manager.act({
        surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-preflight" },
        input_mode: "dom", include_post_screenshot: false,
      }),
      /browser preflight outcome is unknown before dispatch/,
      "arbitrary browser error phrase was accepted as a fixed mutation settlement marker",
    );
  }

  {
    const applications = appStub({
      inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, false)],
      operateApplicationError: new Error("application resource preflight outcome is unknown before dispatch"),
    });
    const manager = managerWith({ applications });
    const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
    await assert.rejects(
      () => manager.act({
        surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" },
        value: "safe", post_screenshot: "never",
      }),
      /application resource preflight outcome is unknown before dispatch/,
      "arbitrary application error phrase was accepted as a fixed mutation settlement marker",
    );
  }
}

async function applicationSetValueDoesNotVerifySiblingWindowTarget() {
  const calls = [];
  const initial = appSnapshot(false, false);
  initial.elements[0].screen_box = { x: 100, y: 90, width: 120, height: 50 };
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].window_screen_box = { x: 500, y: 0, width: 400, height: 300 };
  const applications = appStub({
    inspectQueue: [initial, preflight, post],
    calls,
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "hello", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "unknown", "set_value was verified against a same-selector target in a sibling AXWindow");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks[0].reason, "post_target_binding_unavailable");
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false, "private value readback ran against a sibling-window target");
}

async function applicationSetValueLiveSensitiveTargetDoesNotRetainResource() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].role = "AXSecureTextField";
  post.elements[0].sensitive = true;
  const applications = appStub({
    inspectQueue: [initial, preflight, post],
    calls,
    operateApplicationResult: { ok: true, matched: 1, selected_index: 0, element: { sensitive: true } },
    verifyApplicationValueResult: { supported: true, matched: true, matched_count: 1, selected_index: 0, reason: "compared" },
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown", "live-sensitive target retained or read back a resource-backed value");
  assert.equal(acted.verification.inconclusive, true);
  assert.equal(acted.verification.post_checks[0].reason, "sensitive_target");
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false, "live-sensitive post target reached value comparison");
  assert.equal(Object.hasOwn(acted.dispatch, "_machine_value_verification_handle"), false);
}

async function applicationSensitiveSetValueDoesNotForceReadback() {
  const calls = [];
  const sensitive = appSnapshot(false, false);
  sensitive.elements[0].role = "AXSecureTextField";
  sensitive.elements[0].sensitive = true;
  const applications = appStub({ inspectQueue: [sensitive, structuredClone(sensitive), structuredClone(sensitive)], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "set_value", target: { ref: "a0" }, value_resource: "account-secret", post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "unknown", "sensitive set_value claimed effect verification without a safe readback contract");
  assert.equal(calls.some((entry) => entry.kind === "verify-value"), false);

  const rejectedManager = managerWith({ applications: appStub({ inspectQueue: [structuredClone(sensitive)] }) });
  const rejectedObserved = await rejectedManager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => rejectedManager.act({
      surface: "application", snapshot_id: rejectedObserved.snapshot_id, action: "set_value", target: { ref: "a0" }, value: "secret",
      expect: { target_value_matches: true },
    }),
    (error) => error instanceof BridgeError && error.code === "invalid_request" && /unavailable for sensitive/.test(error.message),
  );
}

async function applicationProcessRelaunchIsStaleBeforeSemanticDispatch() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const relaunched = structuredClone(initial);
  const applications = appStub({ inspectQueue: [initial, relaunched], processIds: [7001, 7002], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  assert.equal(Object.hasOwn(observed.target, "process_id"), false, "private application pid leaked into the public target");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false, "relaunched same-name application reached semantic dispatch through an old snapshot");
}

async function applicationSamePidGenerationChangeIsStaleBeforeSemanticDispatch() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const replaced = structuredClone(initial);
  const applications = appStub({
    inspectQueue: [initial, replaced],
    processIds: [7001, 7001],
    processGenerations: ["gen-a", "gen-b"],
    calls,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  assert.equal(Object.hasOwn(observed.target, "process_generation"), false, "private application generation leaked into the public target");
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false,
    "same-pid replacement reached semantic dispatch through an old process-generation snapshot");
}

async function applicationActivateRelaunchIsStaleAtDispatch() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)],
    processIds: [7001],
    operationProcessId: 7002,
    calls,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "activate" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.equal(dispatch?.args?.expected_process_id, 7001, "targetless activate did not carry the snapshot process identity to the last hop");
}

async function applicationActivateSamePidGenerationChangeIsStaleAtDispatch() {
  const calls = [];
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)],
    processIds: [7001],
    processGenerations: ["gen-a"],
    operationProcessId: 7001,
    operationProcessGeneration: "gen-b",
    calls,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "activate" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.equal(dispatch?.args?.expected_process_id, 7001);
  assert.equal(dispatch?.args?.expected_process_generation, "gen-a",
    "targetless activate dropped the snapshot process-generation identity at the last hop");
}

async function applicationPostProcessRelaunchCannotConfirmEffect() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const preflight = structuredClone(initial);
  const relaunchedPost = appSnapshot(false, true);
  const applications = appStub({
    inspectQueue: [initial, preflight, relaunchedPost],
    processIds: [7001, 7001, 7002],
    calls,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "not_observed", "a relaunched same-name process falsely confirmed the old process action");
  assert.equal(acted.observed_diff.process_changed, true);
  assert.equal(acted.observed_diff.target_changed, true);
  assert.equal(acted.observed_diff.semantic_changed, true);
  assert.equal(acted.verification.post_checks.some((check) => check.condition === "process_identity" && check.matched === false), true);
  assert.equal(acted.verification.post_checks.find((check) => check.condition === "process_identity")?.evidence_source, "application_process");
  assert.equal(acted.continuation.target_identity_continues, false);
  assert.equal(acted.continuation.mapped_post_target_ref, null);
  assert.equal(acted.continuation.target_identity_reason, "application_process_changed");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function applicationPostSamePidGenerationChangeCannotConfirmEffect() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const preflight = structuredClone(initial);
  const replacedPost = appSnapshot(false, true);
  const applications = appStub({
    inspectQueue: [initial, preflight, replacedPost],
    processIds: [7001, 7001, 7001],
    processGenerations: ["gen-a", "gen-a", "gen-b"],
    operationProcessId: 7001,
    operationProcessGeneration: "gen-a",
    calls,
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "not_observed", "same-pid replacement falsely confirmed the old process action");
  assert.equal(acted.observed_diff.process_changed, true);
  assert.equal(acted.verification.post_checks.some((check) => check.condition === "process_identity" && check.matched === false), true);
  assert.equal(acted.continuation.target_identity_reason, "application_process_changed");
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
}

async function applicationRefsAreSnapshotBoundAndVerified() {
  const calls = [];
  const initial = appSnapshot(false, false);
  const preflight = appSnapshot(false, false);
  const post = appSnapshot(false, true);
  const applications = appStub({ inspectQueue: [initial, preflight, post], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes" });
  assert.equal(observed.semantic.elements[0].ref, "a0");
  const acted = await manager.act({
    surface: "application",
    snapshot_id: observed.snapshot_id,
    action: "focus",
    target: { ref: "a0" },
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.post_observation_detail, "summary");
  assert(Array.isArray(acted.post_observation.semantic.elements), "application post-state summary must retain actionable refs");
  assert.equal(acted.post_observation.semantic.elements[0].ref, "a0");
  assert.equal(acted.post_observation.semantic.element_count, 1);
  assert.equal(acted.continuation.previous_refs_reusable, false);
  assert.equal(acted.continuation.previous_target_ref, "a0");
  assert.equal(acted.continuation.target_identity_continues, true);
  assert.equal(acted.continuation.mapped_post_target_ref, "a0");
  assert.equal(acted.continuation.use_post_snapshot_ref, true);
  assert.equal(acted.continuation.target_identity_reason, "selector_occurrence_and_owner_window_match");
  assert.equal(acted.continuation.post_snapshot_refs_available, true);
  assert.deepEqual(acted.continuation.salient_post_refs, ["a0"]);
  assert.equal(acted.continuation.reobserve_recommended, false);
  assert.equal(acted.continuation.snapshot_id, acted.post_snapshot_id);
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.deepEqual(dispatch.args.selector, { identifier: "editor" });
  assert.equal(dispatch.args.expected_process_id, 7001, "application dispatch dropped the private snapshot process identity");
  assert.equal(acted.verification.post_checks[0].condition, "target_focused");
}

async function applicationPostObservationCanBeFull() {
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
    post_observation_detail: "full",
  });
  assert.equal(acted.post_observation_detail, "full");
  assert(Array.isArray(acted.post_observation.semantic.elements), "explicit full application post observation lost its semantic tree");
  assert.equal(Object.hasOwn(acted.post_observation.semantic, "element_count"), false, "full application post observation was unexpectedly compacted");
}

async function duplicateApplicationControlsUseOccurrenceIndex() {
  const calls = [];
  const initial = duplicateAppSnapshot(false);
  const preflight = duplicateAppSnapshot(false);
  const post = duplicateAppSnapshot(true);
  const applications = appStub({ inspectQueue: [initial, preflight, post], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({
    surface: "application", application: "Demo", max_depth: 3, include_menus: true, include_screenshot: false,
  });
  const acted = await manager.act({
    surface: "application",
    snapshot_id: observed.snapshot_id,
    action: "focus",
    target: { ref: "a1" },
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.observed_diff.semantic_delta.added_count, 0, "salience reorder created a false added duplicate");
  assert.equal(acted.observed_diff.semantic_delta.removed_count, 0, "salience reorder created a false removed duplicate");
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 1, "focused duplicate change was not tracked through private raw occurrence identity");
  assert.deepEqual(acted.observed_diff.semantic_delta.changed[0].changed_fields, ["focused"]);
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.equal(dispatch.args.selector.index, 1, "duplicate AX identities must preserve observed occurrence");
  assert.equal(dispatch.args.selector.role, "AXButton");
  assert.equal(dispatch.args.selector.name, "Row");
  assert.equal(dispatch.args.max_depth, 3, "application dispatch changed the snapshot AX traversal depth");
  assert.equal(dispatch.args.include_menus, true, "application dispatch changed the snapshot menu traversal policy");
  const inspectCalls = calls.filter((entry) => entry.kind === "inspect-app");
  assert.equal(inspectCalls[1].args.max_depth, 3, "application ref preflight did not reuse the snapshot AX traversal depth");
  assert.equal(inspectCalls[1].args.include_menus, true, "application ref preflight did not reuse the snapshot menu traversal policy");
  assert.equal(acted.continuation.previous_refs_reusable, false);
  assert.equal(acted.continuation.previous_target_ref, "a1");
  assert.equal(acted.continuation.target_identity_continues, true, "duplicate occurrence identity was not continued through salience reorder");
  assert.equal(acted.continuation.mapped_post_target_ref, "a0", "continuation reused the old aN instead of mapping to the new post-snapshot ref");
  assert.equal(acted.continuation.salient_post_refs[0], "a0", "mapped post target was not promoted in continuation hints");
}

async function applicationPostTargetRemovalDoesNotMap() {
  const initial = appSnapshot(false, false);
  const preflight = appSnapshot(false, false);
  const post = appSnapshot(false, false);
  post.elements = [];
  const manager = managerWith({ applications: appStub({ inspectQueue: [initial, preflight, post], repeatLastInspect: true }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "not_observed");
  assert.equal(acted.continuation.previous_refs_reusable, false);
  assert.equal(acted.continuation.target_identity_continues, false);
  assert.equal(acted.continuation.mapped_post_target_ref, null);
  assert.equal(acted.continuation.use_post_snapshot_ref, false);
  assert.equal(acted.continuation.target_identity_reason, "target_identity_missing_from_post_snapshot");
  assert.equal(Object.hasOwn(acted.retry_guidance, "mapped_post_target_ref"), false, "recovery invented a mapped ref after target removal");
}

async function applicationContinuationRejectsSiblingWindowIdentity() {
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].focused = true;
  post.elements[0].window_screen_box = { x: 500, y: 0, width: 400, height: 300 };
  const manager = managerWith({ applications: appStub({ inspectQueue: [initial, preflight, post], repeatLastInspect: true }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "not_observed", "sibling-window target state falsely confirmed the original focus effect");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_focused", matched: false, evidence_source: "application_accessibility" }]);
  assert.equal(acted.continuation.target_identity_continues, false, "same selector occurrence in a sibling AXWindow was treated as the same target");
  assert.equal(acted.continuation.mapped_post_target_ref, null);
  assert.equal(acted.continuation.target_identity_reason, "owner_window_changed");
}

async function applicationContinuationRequiresSymmetricOwnerEvidence() {
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].focused = true;
  delete post.elements[0].window_screen_box;
  const manager = managerWith({ applications: appStub({ inspectQueue: [initial, preflight, post], repeatLastInspect: true }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "not_observed", "post target without symmetric owner evidence confirmed the original focus effect");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "target_focused", matched: false, evidence_source: "application_accessibility" }]);
  assert.equal(acted.continuation.target_identity_continues, false, "post snapshot without owner-window evidence inherited the old window identity");
  assert.equal(acted.continuation.mapped_post_target_ref, null);
  assert.equal(acted.continuation.target_identity_reason, "owner_window_changed");
}

async function applicationContinuationAllowsLayoutMovement() {
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].focused = true;
  post.elements[0].screen_box = { x: 180, y: 130, width: 120, height: 50 };
  const manager = managerWith({ applications: appStub({ inspectQueue: [initial, preflight, post] }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed");
  assert.equal(acted.continuation.target_identity_continues, true, "legitimate post-action layout movement broke semantic identity continuity");
  assert.equal(acted.continuation.mapped_post_target_ref, "a0");
  assert.equal(acted.continuation.target_identity_reason, "selector_occurrence_and_owner_window_match");
}

async function applicationOwnerWindowMigrationCountsAsSemanticChange() {
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const preflight = structuredClone(initial);
  const post = structuredClone(initial);
  post.elements[0].window_screen_box = { x: 500, y: 0, width: 400, height: 300 };
  const manager = managerWith({ applications: appStub({ inspectQueue: [initial, preflight, post] }) });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "press", target: { ref: "a0" },
    expect: { semantic_change: true }, post_screenshot: "never",
  });
  assert.equal(acted.effect_status, "confirmed", "identity-aware owner-window change did not satisfy explicit application semantic_change");
  assert.equal(acted.observed_diff.semantic_changed, true, "private owner-window identity migration was invisible to application semantic change detection");
  assert.equal(acted.observed_diff.semantic_delta.changed_count, 1);
  assert.deepEqual(acted.observed_diff.semantic_delta.changed[0].changed_fields, ["owner_window"]);
  assert.equal(JSON.stringify(acted.observed_diff).includes('"x":500'), false, "semantic delta leaked private global owner-window coordinates");
  assert.deepEqual(acted.verification.post_checks, [{ condition: "semantic_change", matched: true, evidence_source: "application_accessibility" }]);
  assert.equal(acted.continuation.target_identity_continues, false);
}

async function applicationRefGeometryDriftIsStale() {
  const calls = [];
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const changed = structuredClone(initial);
  changed.elements[0].screen_box.x = 140;
  const applications = appStub({ inspectQueue: [initial, changed], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  const preflight = calls.filter((entry) => entry.kind === "inspect-app")[1];
  assert.equal(preflight.args.include_geometry, true, "geometry-bound ref preflight did not request live AX geometry");
  assert.equal(calls.some((entry) => entry.kind === "operate"), false, "moved AX target reached dispatch instead of becoming stale");
}

async function applicationRefOwnerWindowDriftIsStale() {
  const calls = [];
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const changed = structuredClone(initial);
  changed.elements[0].window_screen_box = { x: 20, y: 20, width: 400, height: 300 };
  const applications = appStub({ inspectQueue: [initial, changed], calls });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false, "same selector in a different AX window reached dispatch");
}

async function applicationDispatchGeometryGuardMapsToStale() {
  const calls = [];
  const initial = appButtonSnapshot("Save", "save", { x: 100, y: 90, width: 120, height: 50 });
  initial.elements[0].window_screen_box = { x: 0, y: 0, width: 400, height: 300 };
  const applications = appStub({
    inspectQueue: [initial, structuredClone(initial)],
    calls,
    operateApplicationError: new Error("application target geometry changed before dispatch"),
  });
  const manager = managerWith({ applications });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  await assert.rejects(
    () => manager.act({ surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" } }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "stale_snapshot",
  );
  const dispatch = calls.find((entry) => entry.kind === "operate");
  assert.deepEqual(dispatch.args.expected_window_bounds, { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(dispatch.args.expected_element_bounds, { x: 100, y: 90, width: 120, height: 50 });
}

async function surfaceSpecificArgumentsAreRejected() {
  const calls = [];
  const invalidSnapshot = browserSnapshot("https://example.test/a", "e1");
  const browser = browserStub({ inspectQueue: [invalidSnapshot, structuredClone(invalidSnapshot)], calls });
  const applications = appStub({ inspectQueue: [appSnapshot(false, false)] });
  const manager = managerWith({ browser, applications });
  await assert.rejects(
    () => manager.observe({ surface: "browser", application: "Notes", include_screenshot: false }),
    (error) => error instanceof BridgeError && error.code === "invalid_request",
  );
  await assert.rejects(
    () => manager.observe({ surface: ["browser"], include_screenshot: false }),
    (error) => error instanceof BridgeError && error.code === "invalid_request",
  );
  await assert.rejects(
    () => manager.observe({ surface: "application", application: ["Notes"], include_screenshot: false }),
    (error) => error instanceof BridgeError && error.code === "invalid_request",
  );
  for (const invalidObserve of [
    { tab_id: null }, { max_elements: null }, { max_ax_nodes: null }, { max_frames: null }, { ax_depth: null },
    { include_values: null }, { all_frames: null }, { include_screenshot: null }, { screenshot_format: null },
    { screenshot_quality: null }, { timeout_seconds: null }, { focus_query: null },
  ]) {
    await assert.rejects(
      () => manager.observe({ surface: "browser", ...invalidObserve }),
      (error) => error instanceof BridgeError && error.code === "invalid_request",
    );
  }
  assert.equal(calls.length, 0, "coercible observe authority reached the browser backend");

  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  const invalidActs = [
    { surface: ["browser"], snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" } },
    { surface: "browser", snapshot_id: [observed.snapshot_id], action: "click", target: { ref: "e1" } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: ["click"], target: { ref: "e1" } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: ["e1"] } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, verify_timeout_seconds: [5] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, verify_timeout_seconds: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, input_mode: ["dom"] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, input_mode: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, input_mode: "" },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, wait_for: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, wait_for: "" },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, expect: { target_state: ["visible"] } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, expect: { load_state: ["complete"] } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "check", target: { ref: "e1" }, expect: { target_state: ["checked"] } },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_screenshot: ["never"] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_screenshot: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_screenshot: "" },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_observation_detail: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_observation_detail: "" },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, timeout_seconds: [30] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, timeout_seconds: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, element_timeout_seconds: [10] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, element_timeout_seconds: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_max_elements: [180] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_max_elements: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_max_ax_nodes: [180] },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" }, post_max_ax_nodes: null },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "fill", target: { ref: "e1" }, value_resource: " account-secret" },
    { surface: "browser", snapshot_id: observed.snapshot_id, action: "scroll", target: { ref: "e1" }, delta_x: null, delta_y: 10 },
  ];
  for (const args of invalidActs) {
    const callArgs = Object.hasOwn(args, "post_screenshot") ? args : { ...args, include_post_screenshot: false };
    await assert.rejects(() => manager.act(callArgs),
      (error) => error instanceof BridgeError && error.code === "invalid_request");
  }
  assert.equal(calls.some((entry) => ["act", "backend-act", "point-act"].includes(entry.kind)), false,
    "coercible Computer Use action authority reached the browser mutation backend");
  const valid = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" },
    input_mode: "dom", include_post_screenshot: false,
  });
  assert.equal(valid.dispatch_status, "completed", "pre-dispatch argument rejection consumed the otherwise valid snapshot authority");
  assert.equal(calls.filter((entry) => entry.kind === "act").length, 1,
    "valid action after rejected argument cases did not dispatch exactly once");
}

async function snapshotStoreBoundaryMatrix() {
  assert.throws(() => new ComputerUseSnapshotStore({}), /requires an id factory/);
  const defaultStore = new ComputerUseSnapshotStore({ createId: () => "cu_default" });
  const defaultObservation = { surface: "browser" };
  assert.equal(defaultStore.get(defaultStore.add(defaultObservation)).observation, defaultObservation,
    "default monotonic Computer Use snapshot clock did not preserve a fresh snapshot");

  let sequence = 0;
  const ids = ["cu_same", "cu_same", "cu_other", ...Array.from({ length: 70 }, (_, index) => `cu_cap_${index}`)];
  const store = new ComputerUseSnapshotStore({ now: () => 1000, createId: () => ids[sequence++] || `cu_tail_${sequence}` });
  const first = store.add({ marker: "first" });
  const second = store.add({ marker: "second" });
  assert.notEqual(first, second, "Computer Use snapshot id collision was not retried");
  const claimed = store.get(second);
  assert.equal(store.claim(second, claimed), claimed, "Computer Use snapshot claim did not consume the expected generation");
  await assert.rejects(async () => store.claim(second, claimed),
    (error) => error instanceof BridgeError && error.details?.reason === "snapshot_missing_or_expired");
  store.discard("");
  const disposable = store.add({ marker: "discard" });
  store.discard(disposable);
  await assert.rejects(async () => store.get(disposable), /missing or expired/);
  for (let index = 0; index < 65; index += 1) store.add({ marker: `cap-${index}` });
  await assert.rejects(async () => store.get(first), /missing or expired/);
  assert.equal(store.items.size, 64, "Computer Use snapshot store exceeded its bounded capacity");

  const invalidClock = new ComputerUseSnapshotStore({ now: () => Number.NaN, createId: () => "cu_nan" });
  assert.throws(() => invalidClock.add({}), /non-finite/);
}

async function snapshotStoreIgnoresClockRollback() {
  let clock = 1000;
  let sequence = 0;
  const store = new ComputerUseSnapshotStore({ now: () => clock, createId: () => `cu_clock${++sequence}` });
  const observation = { surface: "browser" };
  const id = store.add(observation);
  clock = 500;
  assert.equal(store.get(id).observation, observation, "backward clock movement expired a live Computer Use snapshot");
  clock = 1000 + 10 * 60 * 1000 + 1;
  await assert.rejects(async () => store.get(id),
    (error) => error instanceof BridgeError && error.details?.reason === "snapshot_missing_or_expired");
}

async function expiredSnapshotsCannotBeUsed() {
  let now = 1000;
  let sequence = 0;
  const browser = browserStub({ inspectQueue: [browserSnapshot("https://example.test/a", "e9")] });
  const manager = new ComputerUseManager({
    authorizeTool() {},
    browserBridgeManager: browser,
    appAutomationManager: appStub({ inspectQueue: [] }),
    now: () => now,
    createId: () => `cu_test${String(++sequence).padStart(8, "0")}`,
  });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e9" }, include_post_screenshot: false }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
}

function managerWith({
  browser = browserStub({ inspectQueue: [] }),
  applications = appStub({ inspectQueue: [] }),
  throwIfCancelled = () => {},
  now = null,
  sleep = null,
}) {
  let sequence = 0;
  let clock = 1000;
  return new ComputerUseManager({
    authorizeTool() {},
    browserBridgeManager: browser,
    appAutomationManager: applications,
    throwIfCancelled,
    now: now || (() => clock),
    sleep: sleep || (async (milliseconds) => { clock += Math.max(0, Number(milliseconds) || 0); }),
    createId: () => `cu_test${String(++sequence).padStart(8, "0")}`,
  });
}

function browserStub({ inspectQueue, tabUrl = null, calls = [], actError = null, pointActionError = null, backendNodeActionError = null, documentStateEpoch = null, documentStateHistoryEntryKey = null, documentStateViewport = null, documentStateError = null, enhanced = false, screenshotHashes = [], checkedState = null, backendToggleNoInput = false, backendTogglePreFocusNoInput = false, postDispatchWaitError = null, backendBindingConfidence = "high" }) {
  const queue = [...inspectQueue];
  let initialUrl = tabUrl || queue[0]?.url || "https://example.test/";
  let observedEpoch = queue[0]?.frames?.[0]?.document?.epoch ?? "doc-default";
  let observedHistoryEntryKey = String(queue[0]?._machine_history_entry_key || "");
  const hashes = [...screenshotHashes];
  let currentChecked = checkedState;
  return {
    async observeComputer(args) {
      calls.push({ kind: "observe", args });
      const next = queue.shift();
      if (!next) throw new Error("unexpected browser observe");
      const nextDocumentEpoch = Object.hasOwn(next, "document_epoch")
        ? next.document_epoch
        : next.frames?.[0]?.document?.epoch;
      if (nextDocumentEpoch !== undefined) observedEpoch = nextDocumentEpoch;
      const captureSemanticEpoch = next.capture && Object.hasOwn(next.capture, "semantic_epoch")
        ? next.capture.semantic_epoch
        : observedEpoch;
      observedHistoryEntryKey = String(next._machine_history_entry_key || observedHistoryEntryKey);
      if (!tabUrl) initialUrl = initialUrl || next.url;
      const screenshotHash = args.include_screenshot === false ? "" : (hashes.shift() || "a".repeat(64));
      const trustedNodes = [];
      const frameTreeById = new Map();
      for (const frame of next.frames || []) {
        const frameUrl = typeof frame?.document?.url === "string" ? frame.document.url : "";
        const fallbackCdpFrameId = Number.isSafeInteger(frame?.frame_id) && frame.frame_id >= 0 ? `cdp-test-${frame.frame_id}` : "";
        for (const element of Array.isArray(frame?.elements) ? frame.elements : []) {
          const backendNodeId = element?._machine_backend_node_id;
          const ref = typeof element?.ref === "string" ? element.ref : "";
          const frameId = typeof element?._machine_cdp_frame_id === "string" && element._machine_cdp_frame_id
            ? element._machine_cdp_frame_id : fallbackCdpFrameId;
          if (!ref || !frameId || !frameUrl || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
          frameTreeById.set(frameId, { id: frameId, url: frameUrl });
          trustedNodes.push({
            action_ref: ref, action_ref_confidence: backendBindingConfidence,
            backend_dom_node_id: backendNodeId, frame_id: frameId,
          });
        }
      }
      return {
        tab_id: next.tab_id,
        title: next.title,
        url: next.url,
        semantic: structuredClone(next),
        accessibility: trustedNodes.length
          ? { kind: "chromium-accessibility", available: true, nodes: trustedNodes }
          : enhanced ? { kind: "chromium-accessibility", nodes: [] } : null,
        viewport: enhanced ? { width: 800, height: 600, scale: 1 } : null,
        frame_tree: [...frameTreeById.values()],
        document_epoch: observedEpoch,
        _machine_history_entry_key: String(next._machine_history_entry_key || ""),
        capture: {
          atomic: false, navigation_coherent: true, semantic_epoch: captureSemanticEpoch, cdp_epoch: enhanced ? `frame:loader:${next.url}` : "", cdp: enhanced,
          screenshot_source: args.include_screenshot === false ? "none" : enhanced ? "cdp_surface" : "capture_visible_tab_legacy",
          screenshot_sha256: screenshotHash,
          coherence: "test",
        },
        imageContent: args.include_screenshot === false ? [] : [{ type: "image", data: "AA==", mimeType: "image/png" }],
      };
    },
    async documentState(args) {
      calls.push({ kind: "document-state", args });
      if (documentStateError) throw documentStateError;
      return {
        tab_id: 41, url: initialUrl, document_url: initialUrl, document_epoch: documentStateEpoch || observedEpoch, ready_state: "complete",
        _machine_history_entry_key: documentStateHistoryEntryKey === null
          ? observedHistoryEntryKey
          : String(documentStateHistoryEntryKey || ""),
        viewport: documentStateViewport || { width: 800, height: 600, scale: 1, offset_left: 0, offset_top: 0 },
      };
    },
    async backendNodeAction(args) {
      calls.push({ kind: "backend-act", args });
      if (backendNodeActionError) throw backendNodeActionError;
      if (args.action === "check") currentChecked = true;
      if (args.action === "uncheck") currentChecked = false;
      const textAction = ["press", "type_text", "fill", "check", "uncheck", "submit"].includes(args.action);
      const toggleAction = args.action === "check" || args.action === "uncheck";
      const preFocusNoInput = backendTogglePreFocusNoInput && toggleAction;
      const noInputRequired = (backendToggleNoInput || backendTogglePreFocusNoInput) && toggleAction;
      return {
        ok: true, input_mode: "trusted", trusted_input_fallback: false,
        coordinate_source: preFocusNoInput ? "cdp_ax_state_noop" : textAction ? "cdp_dom_focus" : "cdp_content_quad",
        no_input_required: noInputRequired,
        cross_frame_trusted: Number(args.extension_frame_id) > 0, tab_id: 41, url: initialUrl, title: "Example", tab_metadata_verified: true,
        ...(textAction ? {} : {
          point: { x: 150, y: 120 },
          ...(args.action === "drag" ? { destination_point: { x: 550, y: 330 } } : {}),
          ...(args.action === "scroll" ? { scroll_delta: { delta_x: args.delta_x, delta_y: args.delta_y } } : {}),
        }),
      };
    },
    async pointAction(args) {
      calls.push({ kind: "point-act", args });
      if (pointActionError) throw pointActionError;
      return {
        ok: true, input_mode: "trusted", trusted_input_fallback: false, tab_id: 41, url: initialUrl, title: "Example",
        point: { normalized_x: args.normalized_x, normalized_y: args.normalized_y, css_x: args.normalized_x * 800, css_y: args.normalized_y * 600 },
        ...(args.action === "drag" ? { destination_point: {
          normalized_x: args.destination_normalized_x, normalized_y: args.destination_normalized_y,
          css_x: args.destination_normalized_x * 800, css_y: args.destination_normalized_y * 600,
        } } : {}),
        ...(args.action === "scroll" ? { scroll_delta: { delta_x: args.delta_x, delta_y: args.delta_y } } : {}),
        hit: { ref: "e-hit", tag: "canvas", role: "", name: "", sensitive: false, bounding_box: { x: 0, y: 0, width: 800, height: 600 } },
        ...(args.action === "drag" ? { destination_hit: { ref: "e-drop", tag: "canvas", role: "", name: "", sensitive: false } } : {}),
      };
    },
    async listTabs(args) {
      calls.push({ kind: "tabs", args });
      return { tabs: [{ id: 41, url: initialUrl, title: "Example" }] };
    },
    async wait(args) {
      calls.push({ kind: "wait", args });
      if (postDispatchWaitError && args.load_state) throw postDispatchWaitError;
      if (args.state === "checked" || args.state === "unchecked") {
        const expected = args.state === "checked";
        if (currentChecked === null || currentChecked !== expected) throw new Error(`fixture state is ${currentChecked}`);
      }
      return { ok: true };
    },
    async act(args) {
      calls.push({ kind: "act", args });
      if (actError) throw actError;
      return { ok: true, tab_id: 41, url: initialUrl, title: "Example", input_mode: "trusted", trusted_input_fallback: false };
    },
  };
}

function browserSnapshot(url, ref, epoch = `doc-${ref}`) {
  return {
    tab_id: 41,
    title: "Example",
    url,
    _machine_history_entry_key: `history-${ref}`,
    frames: [{
      frame_id: 3,
      snapshot_version: 3,
      document: { url, epoch },
      elements: [{ ref, role: "button", name: "Continue", visible: true, enabled: true, bounding_box: { x: 1, y: 2, width: 30, height: 20 } }],
      truncated: false,
    }],
    total_elements: 1,
    max_elements: 300,
    frames_truncated: false,
  };
}

function browserChildFrameSnapshot({ childEpoch, ref }) {
  const url = "https://example.test/child-frame";
  return {
    tab_id: 41,
    title: "Example",
    url,
    frames: [
      {
        frame_id: 0,
        snapshot_version: 3,
        document: { url, epoch: "doc-top-stable" },
        elements: [],
        truncated: false,
      },
      {
        frame_id: 5,
        snapshot_version: 3,
        document: { url: "https://child.example/frame", epoch: childEpoch },
        elements: [{ ref, role: "button", name: "Continue", visible: true, enabled: true, bounding_box: { x: 4, y: 5, width: 40, height: 24 } }],
        truncated: false,
      },
    ],
    total_elements: 1,
    max_elements: 300,
    frames_truncated: false,
  };
}

function appStub({ inspectQueue, inspectErrors = null, repeatLastInspect = false, calls = [], screenshotResult = null, screenshotResults = null, screenshotError = null, pointApplicationError = null, dragApplicationError = null, scrollApplicationError = null, operateApplicationError = null, operateApplicationResult = null, verifyApplicationValueResult = null, verifyApplicationValueError = null, windowStateResults = null, windowStateError = null, inlineWindowState = true, processIds = null, processGenerations = null, screenshotProcessId = 7001, screenshotProcessGeneration = `gen-${screenshotProcessId}`, operationProcessId = 7001, operationProcessGeneration = `gen-${operationProcessId}` }) {
  const queue = [...inspectQueue];
  const inspectErrorQueue = Array.isArray(inspectErrors) ? [...inspectErrors] : [];
  let lastInspect = null;
  const shots = Array.isArray(screenshotResults) ? [...screenshotResults] : screenshotResult ? [screenshotResult] : [];
  const windowStates = Array.isArray(windowStateResults) ? [...windowStateResults] : [];
  const processQueue = Array.isArray(processIds) && processIds.length ? [...processIds] : [7001];
  const generationQueue = Array.isArray(processGenerations) && processGenerations.length ? [...processGenerations] : null;
  let lastCapture = null;
  const assertExpectedIdentity = (args, processId, processGeneration) => {
    if (args.expected_process_id !== undefined && Number(args.expected_process_id) !== Number(processId)) {
      throw new Error("application process changed before operation");
    }
    if (args.expected_process_generation !== undefined && String(args.expected_process_generation) !== String(processGeneration)) {
      throw new Error("application process generation changed before operation");
    }
  };
  const stub = {
    async inspectApplication(args) {
      calls.push({ kind: "inspect-app", args });
      const inspectError = inspectErrorQueue.length ? inspectErrorQueue.shift() : null;
      if (inspectError) throw inspectError;
      const next = queue.shift() || (repeatLastInspect ? lastInspect : null);
      if (!next) throw new Error("unexpected application inspect");
      lastInspect = next;
      const result = structuredClone(next);
      const processId = processQueue.length > 1 ? Number(processQueue.shift()) : Number(processQueue[0]);
      const processGeneration = generationQueue
        ? String(generationQueue.length > 1 ? generationQueue.shift() : generationQueue[0])
        : `gen-${processId}`;
      if (args.expected_process_id !== undefined && Number(args.expected_process_id) !== processId) {
        throw new Error("application process changed before operation");
      }
      if (args.expected_process_generation !== undefined && String(args.expected_process_generation) !== processGeneration) {
        throw new Error("application process generation changed before operation");
      }
      if (args.include_process_id === true) {
        result._machine_process_id = processId;
        result._machine_process_generation = processGeneration;
      }
      if (args.include_window_state === true && inlineWindowState) {
        result._machine_window_state_checked = true;
        const configuredWindowState = windowStates.length
          ? structuredClone(windowStates.length > 1 ? windowStates.shift() : windowStates[0])
          : null;
        const inlineWindow = configuredWindowState?.window || lastCapture?.window || null;
        if (inlineWindow) {
          result._machine_window = {
            id: Number(inlineWindow.id),
            bounds: structuredClone(inlineWindow.bounds),
            process_id: processId,
            process_generation: processGeneration,
          };
        }
      }
      const ownerBounds = lastCapture?.window?.bounds || null;
      if (ownerBounds) {
        for (const element of Array.isArray(result.elements) ? result.elements : []) {
          if (element?.screen_box && !element.window_screen_box) element.window_screen_box = structuredClone(ownerBounds);
        }
      }
      return result;
    },
    async operateApplication(args) {
      calls.push({ kind: "operate", args });
      assertExpectedIdentity(args, operationProcessId, operationProcessGeneration);
      if (operateApplicationError) throw operateApplicationError;
      const result = operateApplicationResult ? structuredClone(operateApplicationResult) : { ok: true, matched: 1, selected_index: 0 };
      if (args.action === "set_value" && args.retain_value_verification === true && result?.element?.sensitive !== true) {
        result._machine_value_verification_handle = "av_123456789012345678901234";
      }
      return result;
    },
    async pointApplication(args) {
      calls.push({ kind: "point-app", args });
      assertExpectedIdentity(args, operationProcessId, operationProcessGeneration);
      if (pointApplicationError) throw pointApplicationError;
      return {
        ok: true, coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
        experimental_backend: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false,
        normalized_point: { x: args.normalized_x, y: args.normalized_y },
      };
    },
    async dragApplication(args) {
      calls.push({ kind: "drag-app", args });
      assertExpectedIdentity(args, operationProcessId, operationProcessGeneration);
      if (dragApplicationError) throw dragApplicationError;
      return {
        ok: true, coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
        experimental_backend: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false,
        normalized_point: { x: args.normalized_x, y: args.normalized_y },
        destination_normalized_point: { x: args.destination_normalized_x, y: args.destination_normalized_y },
      };
    },
    async scrollApplication(args) {
      calls.push({ kind: "scroll-app", args });
      assertExpectedIdentity(args, operationProcessId, operationProcessGeneration);
      if (scrollApplicationError) throw scrollApplicationError;
      return {
        ok: true, coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
        experimental_backend: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false,
        normalized_point: { x: args.normalized_x, y: args.normalized_y },
        scroll_delta: { delta_x: Math.round(args.delta_x || 0), delta_y: Math.round(args.delta_y || 0) },
      };
    },
    async inspectApplicationWindow(args) {
      calls.push({ kind: "window-state", args });
      assertExpectedIdentity(args, screenshotProcessId, screenshotProcessGeneration);
      if (windowStateError) throw windowStateError;
      if (windowStates.length) {
        const next = windowStates.length > 1 ? windowStates.shift() : windowStates[0];
        return structuredClone(next);
      }
      if (lastCapture?.window) {
        return {
          window: structuredClone(lastCapture.window),
          _machine_process_id: Number(screenshotProcessId),
          _machine_process_generation: String(screenshotProcessGeneration),
        };
      }
      throw new Error("unexpected application window state");
    },
    discardApplicationValueVerification(handle) {
      calls.push({ kind: "discard-value", handle });
      return true;
    },
  };
  if (shots.length || screenshotError) {
    stub.captureApplication = async (args) => {
      calls.push({ kind: "capture-app", args });
      assertExpectedIdentity(args, screenshotProcessId, screenshotProcessGeneration);
      if (screenshotError) throw screenshotError;
      const next = shots.length > 1 ? shots.shift() : shots[0];
      if (!next) throw new Error("unexpected application screenshot");
      lastCapture = structuredClone(next);
      lastCapture._machine_process_id = Number(screenshotProcessId);
      lastCapture._machine_process_generation = String(screenshotProcessGeneration);
      return structuredClone(lastCapture);
    };
  }
  if (verifyApplicationValueResult || verifyApplicationValueError) {
    stub.verifyApplicationValue = async (args) => {
      calls.push({ kind: "verify-value", args });
      assertExpectedIdentity(args, operationProcessId, operationProcessGeneration);
      if (verifyApplicationValueError) throw verifyApplicationValueError;
      return structuredClone(verifyApplicationValueResult);
    };
  }
  return stub;
}

function duplicateAppSnapshot(secondFocused) {
  return {
    application: "Demo",
    process_name: "Demo",
    platform: "darwin",
    frontmost: true,
    elements: [0, 1].map((index) => ({
      index,
      role: "AXButton",
      subrole: "",
      name: "Row",
      title: "",
      description: "",
      identifier: "",
      enabled: true,
      focused: index === 1 && secondFocused,
      sensitive: false,
    })),
    truncated: false,
    menus_included: false,
  };
}

function appSnapshot(frontmost, focused) {
  return {
    application: "Notes",
    process_name: "Notes",
    platform: "darwin",
    frontmost,
    elements: [{
      index: 0,
      role: "AXTextArea",
      subrole: "",
      name: "Editor",
      title: "",
      description: "",
      identifier: "editor",
      enabled: true,
      focused,
      sensitive: false,
    }],
    truncated: false,
    menus_included: false,
  };
}

function appButtonSnapshot(name, identifier, screenBox) {
  return {
    application: "Notes",
    process_name: "Notes",
    platform: "darwin",
    frontmost: false,
    elements: [{
      index: 0,
      role: "AXButton",
      subrole: "",
      name,
      title: "",
      description: "",
      identifier,
      enabled: true,
      focused: false,
      sensitive: false,
      screen_box: { ...screenBox },
    }],
    truncated: false,
    menus_included: false,
  };
}

function appCheckboxSnapshot(checked) {
  return {
    application: "Notes",
    process_name: "Notes",
    platform: "darwin",
    frontmost: false,
    elements: [{
      index: 0,
      role: "AXCheckBox",
      subrole: "",
      name: "Remember",
      title: "",
      description: "",
      identifier: "remember",
      enabled: true,
      focused: false,
      checked,
      selected: null,
      expanded: null,
      sensitive: false,
    }],
    truncated: false,
    menus_included: false,
  };
}
