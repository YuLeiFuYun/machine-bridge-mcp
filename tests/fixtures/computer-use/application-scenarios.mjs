import assert from "node:assert/strict";
import { ComputerUseManager } from "../../../src/local/computer-use.mjs";
import { ComputerUseSnapshotStore } from "../../../src/local/computer-use-snapshot-store.mjs";
import { computerActRemainingTimeoutSeconds } from "../../../src/local/computer-use-deadline.mjs";
import { BridgeError } from "../../../src/local/errors.mjs";
import {
  PNG_A_BASE64, PNG_B_BASE64, PNG_A_SHA256,
  managerWith, browserStub, browserSnapshot,
  appStub, appSnapshot, appButtonSnapshot, appCheckboxSnapshot, duplicateAppSnapshot,
} from "./common.mjs";

export async function runApplicationComputerUseTests() {
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
  computerUseDeadlineIntegerProjectionStaysWithinBudget();
  await computerObserveUsesOneEndToEndTimeoutBudget();
  await computerActUsesOneEndToEndTimeoutBudget();
  await computerActPreflightDeadlinePreservesDefiniteTimeout();
  await computerActDeadlineExhaustionBeforeDispatchIsDefinite();
  await computerActDeadlineExhaustionAfterDispatchRequiresReobserve();
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
  await incompleteApplicationSemanticEffectStaysUnknown();
  await applicationGeometryOmissionCannotConfirmAnEffect();
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
  assert.equal(result.$mcp.content[1].data, PNG_A_BASE64);
  assert.equal(result.$mcp.content[1].mimeType, "image/png");
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
  assert.deepEqual(inspectCalls.slice(-2).map((entry) => entry.args.timeout_seconds), [1, 1],
    "application verifier let the first post-capture escape the declared verification budget");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1);
}

function computerUseDeadlineIntegerProjectionStaysWithinBudget() {
  const deadline = { remainingMs: () => 999 };
  assert.equal(computerActRemainingTimeoutSeconds(deadline, 30), 0,
    "Computer Use rounded a sub-second remainder up to a one-second child timeout beyond the end-to-end deadline");
  deadline.remainingMs = () => 1_000;
  assert.equal(computerActRemainingTimeoutSeconds(deadline, 30), 1,
    "Computer Use discarded one full child-timeout second from the remaining execution budget");
  deadline.remainingMs = () => 1_999;
  assert.equal(computerActRemainingTimeoutSeconds(deadline, 30), 1,
    "Computer Use child timeout exceeded the whole-second execution budget remaining");
}

async function computerObserveUsesOneEndToEndTimeoutBudget() {
  const calls = [];
  let clock = 1000;
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false)],
    screenshotResult: { screenshot: { mime_type: "image/png", data: PNG_A_BASE64, source: "macos_window" } },
    calls,
  });
  const captureApplication = applications.captureApplication.bind(applications);
  applications.captureApplication = async (args) => {
    const result = await captureApplication(args);
    clock += 6_000;
    return result;
  };
  const inspectApplication = applications.inspectApplication.bind(applications);
  applications.inspectApplication = async (args) => {
    const result = await inspectApplication(args);
    clock += 1_000;
    return result;
  };
  const manager = managerWith({ applications, now: () => clock });
  await manager.observe({
    surface: "application", application: "Notes", include_screenshot: true, timeout_seconds: 10,
  });
  const capture = calls.find((entry) => entry.kind === "capture-app");
  const inspect = calls.find((entry) => entry.kind === "inspect-app");
  assert.equal(capture.args.timeout_seconds, 10);
  assert(inspect.args.timeout_seconds <= 4,
    "computer_observe gave AX inspection the full original timeout after screenshot capture consumed budget");
}

async function computerActUsesOneEndToEndTimeoutBudget() {
  const calls = [];
  let clock = 1000;
  let consumeBudget = false;
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false), appSnapshot(false, true)],
    calls,
    operateApplicationResult: { ok: true, matched: 1, selected_index: 0, element: { focused: true, sensitive: false } },
  });
  const inspectApplication = applications.inspectApplication.bind(applications);
  applications.inspectApplication = async (args) => {
    const result = await inspectApplication(args);
    if (consumeBudget) clock += 9_000;
    return result;
  };
  const operateApplication = applications.operateApplication.bind(applications);
  applications.operateApplication = async (args) => {
    const result = await operateApplication(args);
    if (consumeBudget) clock += 8_000;
    return result;
  };
  const manager = managerWith({ applications, now: () => clock });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  consumeBudget = true;
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
    post_screenshot: "never", timeout_seconds: 30, verify_timeout_seconds: 30,
  });
  assert.equal(acted.effect_status, "confirmed");
  const operate = calls.find((entry) => entry.kind === "operate");
  assert(operate.args.timeout_seconds < 30,
    "computer_act gave mutation dispatch the full original timeout after preflight had already consumed budget");
  const postInspect = calls.filter((entry) => entry.kind === "inspect-app").at(-1);
  assert(postInspect.args.timeout_seconds <= 13,
    "computer_act post-observation ignored time already consumed by preflight and dispatch");
}

async function computerActPreflightDeadlinePreservesDefiniteTimeout() {
  const calls = [];
  let clock = 1000;
  const browser = browserStub({
    inspectQueue: [browserSnapshot("https://example.test/preflight-deadline", "e-deadline", "doc-deadline")],
    calls,
  });
  const listTabs = browser.listTabs.bind(browser);
  browser.listTabs = async (args) => {
    const result = await listTabs(args);
    clock += 1_000;
    return result;
  };
  const manager = managerWith({ browser, now: () => clock });
  const observed = await manager.observe({ surface: "browser", include_screenshot: false });
  await assert.rejects(
    () => manager.act({
      surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e-deadline" },
      post_screenshot: "never", timeout_seconds: 1,
    }),
    (error) => error instanceof BridgeError
      && error.code === "timeout"
      && error.details?.reason === "computer_action_deadline_exhausted"
      && error.details?.side_effects_started === false,
  );
  assert.equal(calls.some((entry) => entry.kind === "act"), false,
    "computer_act preflight deadline exhaustion reached browser mutation dispatch");
  assert.doesNotThrow(() => manager.snapshots.get(observed.snapshot_id),
    "computer_act consumed snapshot mutation authority even though the end-to-end deadline expired before dispatch");
}

async function computerActDeadlineExhaustionBeforeDispatchIsDefinite() {
  const calls = [];
  let clock = 1000;
  let consumeBudget = false;
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)],
    calls,
  });
  const inspectApplication = applications.inspectApplication.bind(applications);
  applications.inspectApplication = async (args) => {
    const result = await inspectApplication(args);
    if (consumeBudget) clock += 1_000;
    return result;
  };
  const manager = managerWith({ applications, now: () => clock });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  consumeBudget = true;
  await assert.rejects(
    () => manager.act({
      surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
      post_screenshot: "never", timeout_seconds: 1,
    }),
    (error) => error instanceof BridgeError
      && error.code === "timeout"
      && error.details?.reason === "computer_action_deadline_exhausted"
      && error.details?.side_effects_started === false,
  );
  assert.equal(calls.some((entry) => entry.kind === "operate"), false,
    "computer_act dispatched a mutation after its end-to-end deadline was exhausted in preflight");
}

async function computerActDeadlineExhaustionAfterDispatchRequiresReobserve() {
  const calls = [];
  let clock = 1000;
  let consumeBudget = false;
  const applications = appStub({
    inspectQueue: [appSnapshot(false, false), appSnapshot(false, false)],
    calls,
    operateApplicationResult: { ok: true, matched: 1, selected_index: 0, element: { focused: true, sensitive: false } },
  });
  const operateApplication = applications.operateApplication.bind(applications);
  applications.operateApplication = async (args) => {
    const result = await operateApplication(args);
    if (consumeBudget) clock += 2_000;
    return result;
  };
  const manager = managerWith({ applications, now: () => clock });
  const observed = await manager.observe({ surface: "application", application: "Notes", include_screenshot: false });
  consumeBudget = true;
  const acted = await manager.act({
    surface: "application", snapshot_id: observed.snapshot_id, action: "focus", target: { ref: "a0" },
    post_screenshot: "never", timeout_seconds: 2, verify_timeout_seconds: 2,
  });
  assert.equal(acted.dispatch_status, "completed");
  assert.equal(acted.effect_status, "unknown");
  assert.equal(acted.verification.inconclusive, true);
  assert.match(acted.post_observation_error, /error_class=timeout/);
  assert.equal(acted.retry_guidance.same_action_retry_allowed, false);
  assert.equal(acted.retry_guidance.disposition, "reobserve_before_retry");
  assert.equal(calls.filter((entry) => entry.kind === "operate").length, 1,
    "post-dispatch deadline exhaustion replayed the application mutation");
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
      expect: { target_state: "unchecked" }, post_screenshot: "never",
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
        input_mode: "dom", post_screenshot: "never",
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
    const callArgs = Object.hasOwn(args, "post_screenshot") ? args : { ...args, post_screenshot: "never" };
    await assert.rejects(() => manager.act(callArgs),
      (error) => error instanceof BridgeError && error.code === "invalid_request");
  }
  assert.equal(calls.some((entry) => ["act", "backend-act", "point-act"].includes(entry.kind)), false,
    "coercible Computer Use action authority reached the browser mutation backend");
  const valid = await manager.act({
    surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e1" },
    input_mode: "dom", post_screenshot: "never",
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
    () => manager.act({ surface: "browser", snapshot_id: observed.snapshot_id, action: "click", target: { ref: "e9" }, post_screenshot: "never" }),
    (error) => error instanceof BridgeError && error.code === "conflict" && error.details?.reason === "snapshot_missing_or_expired",
  );
}


async function incompleteApplicationSemanticEffectStaysUnknown() {
  for (const expected of [true, false]) {
    const initial = { process_name: "Synthetic", _machine_process_id: 123, _machine_process_generation: "synthetic-generation",
      frontmost: false, truncated: false, menus_included: false, elements: [
        { identifier: "one", role: "AXButton", name: "One", enabled: true, focused: false },
        { identifier: "two", role: "AXButton", name: "Two", enabled: true, focused: false },
      ] };
    let dispatched = false, dispatchCalls = 0, clock = 0;
    const applications = {
      visualPointCapability: () => ({ available: false }),
      async inspectApplication() {
        return structuredClone(dispatched ? { ...initial, truncated: true, elements: initial.elements.slice(0, 1) } : initial);
      },
      async operateApplication() { dispatched = true; dispatchCalls += 1; return { ok: true }; },
    };
    const manager = new ComputerUseManager({ authorizeTool() {}, appAutomationManager: applications,
      browserBridgeManager: {}, now: () => clock, sleep: async (delay) => { clock += delay; } });
    const observation = await manager.observe({ surface: "application", application: "Synthetic", include_screenshot: false });
    const result = await manager.act({ surface: "application", snapshot_id: observation.snapshot_id,
      action: "click", target: { ref: observation.semantic.elements[0].ref },
      expect: { semantic_change: expected }, post_screenshot: "never" });
    assert.equal(result.observed_diff.semantic_changed, null, "application sampling difference was reported as an effect");
    assert.equal(result.effect_status, "unknown");
    assert.equal(result.verification.inconclusive, true);
    assert.equal(dispatchCalls, 1, "inconclusive observation replayed the application mutation");
  }
}

async function applicationGeometryOmissionCannotConfirmAnEffect() {
  for (const expected of [true, false]) {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const generation = "synthetic-geometry-generation";
    let clock = 0, dispatched = 0;
    const applications = {
      visualPointCapability: () => ({ available: false }),
      async captureApplication() {
        return { _machine_process_id: 123, _machine_process_generation: generation, window: { id: 11, bounds },
          screenshot: { source: "macos_window", mime_type: "image/png", data: "iVBORw0KGgo=" } };
      },
      async inspectApplication() {
        return { process_name: "Synthetic", _machine_process_id: 123, _machine_process_generation: generation,
          _machine_window_state_checked: true, _machine_window: { id: 11, bounds, process_id: 123, process_generation: generation },
          frontmost: false, truncated: false, menus_included: false, elements: [
            { identifier: "one", role: "AXButton", name: "One", enabled: true, focused: false,
              screen_box: { x: 10, y: 10, width: 20, height: 20 }, window_screen_box: bounds },
          ] };
      },
      async operateApplication() { dispatched += 1; return { ok: true }; },
    };
    const manager = new ComputerUseManager({ authorizeTool() {}, appAutomationManager: applications, browserBridgeManager: {},
      now: () => clock, sleep: async (delay) => { clock += delay; } });
    const initial = await manager.observe({ surface: "application", application: "Synthetic" });
    const before = initial.$mcp.structuredContent;
    assert(before.semantic.elements[0].bounding_box, "fixture must capture actual window-local geometry before dispatch");
    const result = await manager.act({ surface: "application", snapshot_id: before.snapshot_id, action: "click",
      target: { ref: before.semantic.elements[0].ref }, expect: { semantic_change: expected }, post_screenshot: "never" });
    assert.equal(result.observed_diff.semantic_changed, null, "omitted geometry was mistaken for control movement");
    assert.equal(result.observed_diff.semantic_delta.changed_count, 0);
    assert.equal(result.effect_status, "unknown");
    assert.equal(result.verification.inconclusive, true);
    assert.equal(result.post_observation.semantic.elements[0].visible, null, "unknown visibility was reported as false");
    assert.equal(dispatched, 1, "missing geometry replayed the application mutation");
  }
}
