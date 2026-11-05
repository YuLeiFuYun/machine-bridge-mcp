import {
  browserPostFocusQuery, findApplicationMatch, findPostApplicationTarget, findPostApplicationTargetBinding, sanitizeDispatchResult, trySnapshotBoundBackendAction, browserSnapshotDispatchError, optionalPrivateApplicationProcessId, requiredPrivateApplicationProcessId, optionalPrivateApplicationProcessGeneration, requiredPrivateApplicationProcessGeneration, applicationProcessChanged, applicationProcessIdentityError, applicationVisualDispatchError, applicationProcessIdentityMatches, isVisualPointTarget, browserPointTarget, browserSnapshotIdentity,
} from "./computer-use-dispatch-sanitizers.mjs";
import {
  BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS, staleSnapshot, applicationPointTarget, currentApplicationSemanticPointCandidates, applicationScreenshotBytes, applicationWindowBinding, sameApplicationWindowBinding, sameApplicationWindowIdentity, applicationCaptureCoherence, applicationTargetInspection, applicationTargetHasGeometry, applicationTargetGeometryMatches, applyApplicationTargetGeometry, sameVisualViewport, applicationPostFocusQuery, browserSnapshotIdentityMatches, applicationScreenshotError, applicationWindowRevalidationError, browserObservationSemanticEpoch, privateBrowserHistoryEntryKey, enforceBrowserHistoryDocumentPreflight, defaultSleep,
} from "./computer-use-application-geometry.mjs";
import { combineBrowserPostChecks, browserExpectationNeedsPostObservation, verifyApplicationExpectation, classifyEffectStatus } from "./computer-use-verification.mjs";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BridgeError, errorCode } from "./errors.mjs";
import {
  browserScrollDelta, clampInt, normalizeApplicationAction, normalizeBrowserAction,
  normalizeInputMode, normalizeNavigationWait, normalizePostObservationDetail, normalizePostScreenshotPolicy,
  optionalApplicationFocusQuery, optionalBoolean, requiredResource, requiredSnapshotId,
  requiredString, requiredStringAllowEmpty, requiredSurface, requiredTargetRef, shouldIncludePostScreenshot,
  validateActionDispatchArguments, validateDragTargets, validateObserveArgs, validateSurfaceActionArgs,
} from "./computer-use-arguments.mjs";
import { applicationStateActionTargetSupported, applicationVerificationTarget, normalizeExpectation, validateApplicationStateActionTarget, validateExpectationPrerequisites } from "./computer-use-expectation.mjs";
import { ComputerUseSnapshotStore } from "./computer-use-snapshot-store.mjs";
import { computerActPostObservationTimeoutError, computerActRemainingTimeoutSeconds, computerActVerificationTimeoutProbe, publicPostObservationError, requiredComputerActRemainingTimeoutSeconds, requiredComputerObserveRemainingTimeoutSeconds } from "./computer-use-deadline.mjs";
import { APPLICATION_OPERATION_REASON, applicationOperationReason, settleComputerUseDispatch } from "./computer-use-dispatch-settlement.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { buildBrowserObservation, buildContinuation, extractBrowserPrivateBindings, observationDiff, projectPostObservation } from "./computer-use-observation.mjs";
import { buildRetryGuidance } from "./computer-use-recovery.mjs";
import { applicationElementSupportsPointClick, prepareApplicationObservationElements } from "./computer-use-application-observation.mjs";
import { browserObservationArgs, validateApplicationInspectionEvidence, validateBrowserObservationForSnapshot } from "./computer-use-observation-contract.mjs";
import {
  assertObservationResultFits, fitActionResultToBudget, isResultLimitExceeded, RESULT_BUDGET_OMISSION_REASON,
  observationResult, omitApplicationScreenshotForResultBudget, omitBrowserScreenshotForResultBudget,
} from "./computer-use-result-budget.mjs";

const BROWSER_TARGETLESS_ACTIONS = new Set(["navigate", "reload", "back", "forward"]);
const APPLICATION_VERIFY_POLL_MS = 100;
const APPLICATION_VERIFY_MAX_CAPTURES = 9;

export class ComputerUseManager {
  constructor({
    authorizeTool,
    browserBridgeManager,
    appAutomationManager,
    throwIfCancelled = () => {},
    now = () => performance.now(),
    sleep = defaultSleep,
    createId = () => `cu_${randomBytes(18).toString("base64url")}`,
  }) {
    this.authorizeTool = authorizeTool;
    this.browser = browserBridgeManager;
    this.applications = appAutomationManager;
    this.throwIfCancelled = throwIfCancelled;
    this.now = now;
    this.sleep = sleep;
    this.snapshots = new ComputerUseSnapshotStore({ now, createId });
  }

  async observe(args = {}, context = {}) {
    this.authorizeTool("computer_observe");
    const capture = await this.capture(args, context);
    return observationResult(capture.observation, capture.imageContent);
  }

  async act(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    const surface = requiredSurface(args.surface);
    const snapshotId = requiredSnapshotId(args.snapshot_id);
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot.observation.surface !== surface) {
      throw new BridgeError("conflict", "computer snapshot surface does not match this action", {
        details: { reason: "snapshot_surface_mismatch", expected: snapshot.observation.surface, received: surface },
      });
    }

    const action = surface === "browser" ? normalizeBrowserAction(args.action) : normalizeApplicationAction(args.action);
    validateSurfaceActionArgs(surface, action, args);
    const actionTimeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 60);
    const actionDeadline = createMonotonicDeadline(actionTimeoutSeconds * 1000, this.now);
    const target = this.resolveTarget(snapshot.observation, snapshot.privateState, surface, action, args.target);
    const destination = action === "drag"
      ? this.resolveTarget(snapshot.observation, snapshot.privateState, surface, action, args.destination)
      : null;
    if (action === "drag") validateDragTargets(surface, target, destination);
    validateActionDispatchArguments(surface, action, target, args);
    const expectation = normalizeExpectation(surface, action, target, args.expect);
    const verifyTimeoutSeconds = clampInt(args.verify_timeout_seconds, 5, 1, 60);
    const postScreenshotPolicy = normalizePostScreenshotPolicy(args, surface);
    validateExpectationPrerequisites(expectation, snapshot.observation, postScreenshotPolicy);
    const postObservationDetail = normalizePostObservationDetail(args.post_observation_detail, surface);
    await this.preflight(snapshot.observation, snapshot.privateState, surface, action, target, context, actionDeadline);
    if (destination) await this.preflight(snapshot.observation, snapshot.privateState, surface, action, destination, context, actionDeadline);
    const dispatchTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, actionTimeoutSeconds);
    this.snapshots.claim(snapshotId, snapshot);

    const dispatchArgs = { ...args, timeout_seconds: dispatchTimeoutSeconds };
    const { dispatchStatus, dispatchResult, dispatchError } = await settleComputerUseDispatch(surface, async () => (
      surface === "browser"
        ? await this.dispatchBrowser(snapshot.observation, snapshot.privateState, action, target, dispatchArgs, context, destination)
        : await this.dispatchApplication(snapshot.observation, snapshot.privateState, action, target, dispatchArgs, context, destination)
    ));

    let verificationProbe = { requested: Boolean(expectation), matched: false, reason: expectation ? "not_checked" : "not_requested" };
    if (surface === "browser" && expectation) {
      const browserVerifyTimeoutSeconds = computerActRemainingTimeoutSeconds(actionDeadline, verifyTimeoutSeconds);
      verificationProbe = browserVerifyTimeoutSeconds > 0
        ? await this.verifyBrowserExpectation(
          snapshot.observation,
          target,
          expectation,
          browserVerifyTimeoutSeconds,
          context,
        )
        : computerActVerificationTimeoutProbe();
    }

    const includePostScreenshot = shouldIncludePostScreenshot(postScreenshotPolicy, { surface, target, expectation, dispatchStatus });
    const initialPostCaptureTimeoutSeconds = computerActRemainingTimeoutSeconds(actionDeadline, actionTimeoutSeconds);
    const applicationPostArgs = surface === "application" ? {
      surface,
      application: snapshot.observation.target.application,
      include_screenshot: includePostScreenshot,
      max_elements: clampInt(args.post_max_elements, 200, 1, 500),
      max_depth: clampInt(args.post_max_depth, 6, 1, 12),
      include_values: false,
      include_menus: args.include_menus === true,
      focus_query: applicationPostFocusQuery(target),
      timeout_seconds: Math.max(1, initialPostCaptureTimeoutSeconds),
    } : null;
    let postCapture = null;
    let postCaptureError = "";
    let observedDiff = null;
    if (surface === "application" && expectation) {
      const applicationVerifyTimeoutSeconds = computerActRemainingTimeoutSeconds(actionDeadline, verifyTimeoutSeconds);
      if (applicationVerifyTimeoutSeconds > 0) {
        const verified = await this.verifyApplicationPostAction({
          beforeObservation: snapshot.observation,
          beforePrivateState: snapshot.privateState,
          target,
          expectation,
          args,
          dispatchResult,
          captureArgs: applicationPostArgs,
          timeoutSeconds: applicationVerifyTimeoutSeconds,
          operationDeadline: actionDeadline,
        }, context);
        postCapture = verified.postCapture;
        postCaptureError = verified.postCaptureError;
        observedDiff = verified.observedDiff;
        verificationProbe = verified.verificationProbe;
      } else {
        verificationProbe = computerActVerificationTimeoutProbe();
        postCaptureError = computerActPostObservationTimeoutError(surface);
      }
    } else {
      const postCaptureTimeoutSeconds = computerActRemainingTimeoutSeconds(actionDeadline, actionTimeoutSeconds);
      if (postCaptureTimeoutSeconds > 0) {
        try {
          postCapture = await this.capture(surface === "browser" ? {
            surface,
            tab_id: snapshot.observation.target.tab_id,
            include_screenshot: includePostScreenshot,
            max_elements: clampInt(args.post_max_elements, 180, 1, 1000),
            max_ax_nodes: clampInt(args.post_max_ax_nodes, 180, 1, 2000),
            max_frames: 16,
            ax_depth: 10,
            include_values: false,
            focus_query: browserPostFocusQuery(target),
            timeout_seconds: postCaptureTimeoutSeconds,
          } : { ...applicationPostArgs, timeout_seconds: postCaptureTimeoutSeconds }, context, surface === "application" ? actionDeadline : null);
        } catch (error) {
          postCaptureError = publicPostObservationError(surface, error);
        }
      } else {
        postCaptureError = computerActPostObservationTimeoutError(surface);
      }
      observedDiff = postCapture
        ? observationDiff(snapshot.observation, postCapture.observation, snapshot.privateState, postCapture.privateState)
        : null;
      if (surface === "browser" && expectation && postCapture) {
        verificationProbe = combineBrowserPostChecks(
          verificationProbe,
          observedDiff,
          expectation,
          snapshot.observation,
          postCapture.observation,
          target,
          (expected, actual) => browserSnapshotIdentityMatches(browserSnapshotIdentity(expected), actual),
        );
      }
    }

    const effectStatus = classifyEffectStatus({ dispatchStatus, expectation, verificationProbe, postCapture });
    const continuation = buildContinuation(
      snapshot.observation,
      postCapture?.observation || null,
      target,
      observedDiff,
      snapshot.privateState,
      postCapture?.privateState || null,
    );
    const retryGuidance = buildRetryGuidance({
      dispatchStatus,
      effectStatus,
      expectationRequested: Boolean(expectation),
      postObservation: postCapture?.observation || null,
      continuation,
    });
    const postScreenshotOmittedForBudget = postCapture?.observation?.capture?.screenshot_omitted_reason === RESULT_BUDGET_OMISSION_REASON;
    const result = {
      surface,
      action,
      snapshot_id: snapshotId,
      dispatch_status: dispatchStatus,
      effect_status: effectStatus,
      verification: verificationProbe,
      observed_diff: observedDiff,
      post_snapshot_id: postCapture?.observation.snapshot_id || null,
      post_observation_detail: postObservationDetail,
      post_screenshot_policy: postScreenshotPolicy,
      post_screenshot_included: Boolean(postCapture?.imageContent?.length),
      ...(postScreenshotOmittedForBudget ? {
        post_screenshot_omitted_reason: RESULT_BUDGET_OMISSION_REASON,
        result_budget_compacted: true,
      } : {}),
      post_observation: postCapture ? projectPostObservation(postCapture.observation, postObservationDetail) : null,
      continuation,
      retry_guidance: retryGuidance,
      dispatch: sanitizeDispatchResult(surface, dispatchResult),
      ...(dispatchError ? { dispatch_error: dispatchError } : {}),
      ...(postCaptureError ? { post_observation_error: postCaptureError } : {}),
      recovery: retryGuidance.message,
    };
    return fitActionResultToBudget({
      result,
      imageContent: postCapture?.imageContent || [],
      beforeObservation: snapshot.observation,
      beforePrivateState: snapshot.privateState,
      postCapture,
      target,
      effectStatus,
      expectationRequested: Boolean(expectation),
      postObservationDetail,
    });
  }

  async capture(args, context, operationDeadline = null) {
    const surface = requiredSurface(args.surface);
    validateObserveArgs(surface, args);
    if (surface === "browser") return this.captureBrowser(args, context);
    return this.captureApplication(args, context, operationDeadline);
  }

  async captureApplicationScreenshot({ application, screenshotRequested, timeoutSeconds, captureDeadline }, context) {
    let screenshot = null;
    let screenshotError = "";
    if (screenshotRequested && typeof this.applications.captureApplication === "function") {
      try {
        screenshot = await this.applications.captureApplication({
          application,
          timeout_seconds: requiredComputerObserveRemainingTimeoutSeconds(captureDeadline, timeoutSeconds),
        }, context);
      } catch (error) {
        screenshotError = applicationScreenshotError(error);
      }
    }
    const screenshotPayload = screenshot?.screenshot;
    const screenshotBytes = screenshotPayload?.mime_type === "image/png" ? applicationScreenshotBytes(screenshotPayload?.data) : null;
    const image = screenshotBytes ? { type: "image", data: screenshotPayload.data, mimeType: "image/png" } : null;
    const screenshotSource = image && typeof screenshotPayload?.source === "string" ? screenshotPayload.source : image ? "unknown" : "none";
    const screenshotSha256 = screenshotBytes ? createHash("sha256").update(screenshotBytes).digest("hex") : "";
    return {
      screenshot,
      screenshotError,
      image,
      screenshotSource,
      screenshotSha256,
      windowBinding: applicationWindowBinding(screenshot, screenshotSha256),
      screenshotProcessId: optionalPrivateApplicationProcessId(screenshot?._machine_process_id),
      screenshotProcessGeneration: optionalPrivateApplicationProcessGeneration(screenshot?._machine_process_generation),
    };
  }

  async captureBrowser(args, context) {
    const captured = await this.browser.observeComputer(browserObservationArgs(args), context);
    this.throwIfCancelled(context);
    const privateState = extractBrowserPrivateBindings(captured);
    validateBrowserObservationForSnapshot(captured);
    const observation = buildBrowserObservation(captured, args);
    let imageContent = Array.isArray(captured.imageContent) ? captured.imageContent : [];
    try {
      assertObservationResultFits(observation, imageContent);
    } catch (error) {
      if (!imageContent.length || !isResultLimitExceeded(error)) throw error;
      omitBrowserScreenshotForResultBudget(observation);
      imageContent = [];
      assertObservationResultFits(observation, imageContent);
    }
    observation.snapshot_id = this.snapshots.add(observation, privateState);
    return { observation, privateState, imageContent };
  }

  async captureApplication(args, context, operationDeadline = null) {
    const application = requiredString(args.application, "application", 300);
    const maxElements = clampInt(args.max_elements, 200, 1, 500);
    const maxDepth = clampInt(args.max_depth, 6, 1, 12);
    const includeValues = optionalBoolean(args.include_values, "include_values", false);
    const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
    const focusQuery = optionalApplicationFocusQuery(args.focus_query);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 60);
    const captureDeadline = operationDeadline || createMonotonicDeadline(timeoutSeconds * 1000, this.now);
    const screenshotRequested = optionalBoolean(args.include_screenshot, "include_screenshot", true);
    const {
      screenshotError, image, screenshotSource, screenshotSha256, windowBinding,
      screenshotProcessId, screenshotProcessGeneration,
    } = await this.captureApplicationScreenshot({ application, screenshotRequested, timeoutSeconds, captureDeadline }, context);
    const inspected = await this.applications.inspectApplication({
      application,
      include_process_id: true,
      ...(screenshotProcessId ? { expected_process_id: screenshotProcessId } : {}),
      ...(screenshotProcessGeneration ? { expected_process_generation: screenshotProcessGeneration } : {}),
      max_depth: maxDepth,
      max_elements: focusQuery ? 500 : maxElements,
      include_values: includeValues,
      include_menus: includeMenus,
      include_geometry: true,
      include_window_state: Boolean(windowBinding),
      timeout_seconds: requiredComputerObserveRemainingTimeoutSeconds(captureDeadline, timeoutSeconds),
    }, context);
    validateApplicationInspectionEvidence(inspected);
    const applicationProcessId = requiredPrivateApplicationProcessId(inspected?._machine_process_id);
    const applicationProcessGeneration = requiredPrivateApplicationProcessGeneration(inspected?._machine_process_generation);
    if (screenshotProcessId && screenshotProcessId !== applicationProcessId) {
      throw staleSnapshot("application process changed between screenshot and Accessibility inspection");
    }
    if (screenshotProcessGeneration && screenshotProcessGeneration !== applicationProcessGeneration) {
      throw staleSnapshot("application process generation changed between screenshot and Accessibility inspection");
    }
    const { windowCoherent, windowRevalidationError } = await this.revalidateApplicationWindow({
      application,
      windowBinding,
      inspected,
      applicationProcessId,
      applicationProcessGeneration,
      timeoutSeconds,
      captureDeadline,
      context,
    });
    const visualPointCapability = this.applications.visualPointCapability();
    const prepared = prepareApplicationObservationElements(inspected.elements, {
      maxElements,
      focusQuery,
      windowBounds: windowCoherent === true ? windowBinding?.bounds || null : null,
      requireWindowOwnership: windowCoherent === true,
      sourceTruncated: inspected.truncated === true,
    });
    const semanticPointCoverageComplete = inspected.truncated === false && prepared.truncated === false;
    const semanticPointGeometry = windowCoherent === true && semanticPointCoverageComplete && prepared.elements.some((element) => (
      element?.bounding_box && prepared.bindings.has(element.ref) && applicationElementSupportsPointClick(element)
    ));
    const captureCoherence = applicationCaptureCoherence({ screenshotRequested, hasImage: Boolean(image), windowCoherent });
    const observation = {
      snapshot_id: "",
      surface: "application",
      captured_at: new Date().toISOString(),
      target: {
        application,
        process_name: inspected.process_name,
        frontmost: inspected.frontmost === true,
      },
      capture: {
        semantic: true,
        screenshot_requested: screenshotRequested,
        screenshot: Boolean(image),
        atomic: !image,
        coherence: captureCoherence,
        window_coherent: windowCoherent,
        screenshot_source: screenshotSource,
        screenshot_sha256: screenshotSha256,
        ...(screenshotError ? { screenshot_error: screenshotError } : {}),
        ...(windowRevalidationError ? { window_revalidation_error: windowRevalidationError } : {}),
      },
      capabilities: {
        snapshot_bound_refs: true,
        stable_backend_refs: false,
        screenshot: typeof this.applications.captureApplication === "function",
        action_verification: true,
        snapshot_bound_visual_points: screenshotSource === "macos_window" && Boolean(windowBinding) && windowCoherent !== false && visualPointCapability.available === true,
        snapshot_bound_semantic_points: semanticPointGeometry,
        accessibility_geometry: prepared.elements.some((element) => element.bounding_box),
        accessibility_geometry_coherent: windowCoherent === true,
        visual_grounding: false,
        visual_point_backend: visualPointCapability.backend || "disabled",
        visual_point_configured: visualPointCapability.configured === true,
        visual_point_probed: visualPointCapability.probed === true,
        visual_point_experimental: visualPointCapability.experimental === true,
        visual_point_error_class: typeof visualPointCapability.error_class === "string"
          ? visualPointCapability.error_class.slice(0, 200) : "",
      },
      semantic: {
        kind: "accessibility",
        elements: prepared.elements,
        truncated: inspected.truncated === true || prepared.truncated,
        menus_included: inspected.menus_included === true,
        selection: prepared.selection,
      },
    };
    const privateState = {
      application_process_id: applicationProcessId,
      application_process_generation: applicationProcessGeneration,
      application_ref_bindings: prepared.bindings,
      application_inspection: { max_depth: maxDepth, include_menus: includeMenus },
    };
    if (windowBinding) privateState.application_window_binding = windowBinding;
    let imageContent = image ? [image] : [];
    try {
      assertObservationResultFits(observation, imageContent);
    } catch (error) {
      if (!imageContent.length || !isResultLimitExceeded(error)) throw error;
      omitApplicationScreenshotForResultBudget(observation);
      imageContent = [];
      assertObservationResultFits(observation, imageContent);
    }
    this.throwIfCancelled(context);
    observation.snapshot_id = this.snapshots.add(observation, privateState);
    return { observation, privateState, imageContent };
  }

  async revalidateApplicationWindow({
    application, windowBinding, inspected, applicationProcessId, applicationProcessGeneration, timeoutSeconds, captureDeadline, context,
  }) {
    if (!windowBinding) return { windowCoherent: null, windowRevalidationError: "" };
    if (inspected?._machine_window_state_checked === true) {
      const currentWindow = inspected?._machine_window || null;
      if (!currentWindow) {
        return { windowCoherent: null, windowRevalidationError: "application window identity could not be revalidated during capture" };
      }
      const currentProcessId = optionalPrivateApplicationProcessId(currentWindow.process_id);
      const currentProcessGeneration = optionalPrivateApplicationProcessGeneration(currentWindow.process_generation);
      if (currentProcessId !== applicationProcessId || currentProcessGeneration !== applicationProcessGeneration) {
        throw staleSnapshot("application process instance changed during Accessibility window revalidation");
      }
      return { windowCoherent: sameApplicationWindowIdentity(windowBinding, currentWindow), windowRevalidationError: "" };
    }
    if (typeof this.applications.inspectApplicationWindow !== "function") {
      return { windowCoherent: null, windowRevalidationError: "" };
    }
    const revalidationTimeoutSeconds = requiredComputerObserveRemainingTimeoutSeconds(captureDeadline, timeoutSeconds);
    try {
      const currentWindow = await this.applications.inspectApplicationWindow({
        application,
        expected_process_id: applicationProcessId,
        expected_process_generation: applicationProcessGeneration,
        timeout_seconds: revalidationTimeoutSeconds,
      }, context);
      return { windowCoherent: sameApplicationWindowIdentity(windowBinding, currentWindow), windowRevalidationError: "" };
    } catch (error) {
      return { windowCoherent: null, windowRevalidationError: applicationWindowRevalidationError(error) };
    }
  }

  resolveTarget(observation, privateState, surface, action, rawTarget) {
    if (surface === "browser") {
      if (BROWSER_TARGETLESS_ACTIONS.has(action)) {
        if (rawTarget !== undefined && rawTarget !== null) throw new BridgeError("invalid_request", `${action} does not accept a target`);
        return null;
      }
      if (isVisualPointTarget(rawTarget)) return browserPointTarget(observation, action, rawTarget);
      const ref = requiredTargetRef(rawTarget);
      const matches = [];
      for (const frame of observation.semantic.frames || []) {
        for (const element of frame.elements || []) if (element?.ref === ref) matches.push({ frame_id: frame.frame_id, element });
      }
      if (matches.length !== 1) {
        throw new BridgeError("conflict", "target ref does not belong uniquely to this computer snapshot", {
          details: { reason: matches.length ? "ambiguous_snapshot_ref" : "unknown_snapshot_ref", ref },
        });
      }
      return {
        kind: "ref",
        ref,
        frame_id: matches[0].frame_id,
        element: matches[0].element,
        trusted_binding: privateState?.browser_ref_bindings?.get?.(ref) || null,
      };
    }

    if (action === "activate") {
      if (rawTarget !== undefined && rawTarget !== null) throw new BridgeError("invalid_request", "activate does not accept a target");
      return null;
    }
    if (isVisualPointTarget(rawTarget)) return applicationPointTarget(observation, privateState, action, rawTarget);
    if (action === "scroll") {
      throw new BridgeError("invalid_request", "application scroll requires a normalized point anchor from the same window snapshot");
    }
    if (action === "double_click") {
      throw new BridgeError("invalid_request", "application double_click requires a normalized point from the same window snapshot");
    }
    const ref = requiredTargetRef(rawTarget);
    const element = (observation.semantic.elements || []).find((candidate) => candidate?.ref === ref) || null;
    const binding = privateState?.application_ref_bindings?.get?.(ref) || null;
    if (!element || !binding) {
      throw new BridgeError("conflict", "target ref does not belong to an addressable element in this computer snapshot", {
        details: { reason: element ? "unaddressable_accessibility_element" : "unknown_snapshot_ref", ref },
      });
    }
    validateApplicationStateActionTarget(action, element);
    return {
      kind: "ref", ref, element, selector: binding.selector, occurrence: binding.occurrence,
      inspection: privateState?.application_inspection || null,
      owner_window_bounds: binding.owner_window_bounds || null,
      screen_box: binding.screen_box || null,
    };
  }

  async preflight(observation, privateState, surface, action, target, context, actionDeadline = null) {
    if (surface === "browser") {
      return this.preflightBrowser(observation, privateState, action, target, context, actionDeadline);
    }

    const expectedProcessId = requiredPrivateApplicationProcessId(privateState?.application_process_id);
    const expectedProcessGeneration = requiredPrivateApplicationProcessGeneration(privateState?.application_process_generation);
    if (action === "activate") return;
    if (target?.kind === "point") {
      if (target.semantic_delivery) {
        await this.preflightApplicationSemanticPoint(
          observation, target, expectedProcessId, expectedProcessGeneration, context, actionDeadline,
        );
        return;
      }
      const visualPointMethod = action === "drag"
        ? this.applications.dragApplication
        : action === "scroll" ? this.applications.scrollApplication : this.applications.pointApplication;
      if (typeof visualPointMethod !== "function") {
        throw new BridgeError("unavailable", "application visual point dispatch is unavailable", {
          details: { reason: "application_visual_preflight_unavailable" },
        });
      }
      return;
    }
    const inspection = applicationTargetInspection(target);
    let current;
    try {
      current = await this.applications.inspectApplication({
        application: observation.target.application,
        include_process_id: true,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        max_depth: inspection.max_depth,
        max_elements: 500,
        include_values: false,
        include_menus: inspection.include_menus,
        include_geometry: applicationTargetHasGeometry(target),
        timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10),
      }, context);
    } catch (error) {
      if (applicationProcessIdentityError(error)) {
        throw staleSnapshot("application process instance changed after the snapshot");
      }
      throw error;
    }
    try { validateApplicationInspectionEvidence(current); }
    catch { throw staleSnapshot("application Accessibility evidence became invalid after the snapshot"); }
    if (!applicationProcessIdentityMatches(current, expectedProcessId, expectedProcessGeneration)) {
      throw staleSnapshot("application process instance changed after the snapshot");
    }
    const matched = findApplicationMatch(current.elements, target.selector, target.occurrence);
    if (!matched) {
      throw staleSnapshot("application target is no longer present with the observed identity");
    }
    if (!applicationTargetGeometryMatches(matched, target)) {
      throw staleSnapshot("application target window or geometry changed after the snapshot");
    }
    if ((action === "check" || action === "uncheck") && !applicationStateActionTargetSupported(action, matched)) {
      throw staleSnapshot("application checked-state target changed after the snapshot");
    }
  }

  async preflightBrowser(observation, privateState, action, target, context, actionDeadline = null) {
    const tabs = await this.browser.listTabs({
      include_pinned: true,
      timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 5),
    }, context);
    const tab = (tabs.tabs || []).find((item) => item.id === observation.target.tab_id || item.tab_id === observation.target.tab_id);
    if (!tab) throw staleSnapshot("browser tab no longer exists");
    const tabUrl = typeof tab.url === "string" ? tab.url : "";
    const snapshotUrl = typeof observation.target.url === "string" ? observation.target.url : "";
    if (!tabUrl || !snapshotUrl || tabUrl !== snapshotUrl) throw staleSnapshot("browser tab navigated after the snapshot");
    const semanticEpoch = typeof observation.capture?.semantic_epoch === "string" ? observation.capture.semantic_epoch : "";
    let currentDocument = null;
    let documentStateError = null;
    if (semanticEpoch && typeof this.browser.documentState === "function") {
      const documentStateTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 5);
      try {
        currentDocument = await this.browser.documentState({
          tab_id: observation.target.tab_id,
          timeout_seconds: documentStateTimeoutSeconds,
        }, context);
        if (currentDocument?.document_epoch !== undefined && currentDocument?.document_epoch !== null
            && (typeof currentDocument.document_epoch !== "string" || currentDocument.document_epoch !== semanticEpoch)) {
          throw staleSnapshot("browser document was replaced after the snapshot");
        }
      } catch (error) {
        if (error instanceof BridgeError && error.details?.reason === "stale_snapshot") throw error;
        documentStateError = error;
      }
    }
    enforceBrowserHistoryDocumentPreflight(
      action, semanticEpoch, privateBrowserHistoryEntryKey(privateState?.browser_history_entry_key), currentDocument, documentStateError,
    );
    if (target?.kind === "point") {
      if (!currentDocument) {
        throw new BridgeError("unavailable", "cannot validate the visual snapshot before point dispatch; observe again or use a semantic ref", {
          details: { reason: "visual_preflight_unavailable", ...(documentStateError ? { error_class: errorCode(documentStateError) } : {}) },
        });
      }
      if (!sameVisualViewport(target.viewport, currentDocument.viewport)) throw staleSnapshot("browser viewport changed after the screenshot");
    } else if (target) {
      const targetWaitTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 1);
      try {
        await this.browser.wait({
          tab_id: observation.target.tab_id,
          frame_id: target.frame_id,
          selector: { ref: target.ref },
          state: "attached",
          timeout_seconds: targetWaitTimeoutSeconds,
        }, context);
      } catch {
        throw staleSnapshot("browser target ref is no longer attached");
      }
    }
  }

  async preflightApplicationSemanticPoint(
    observation, target, expectedProcessId, expectedProcessGeneration, context, actionDeadline = null,
  ) {
    if (typeof this.applications.captureApplication !== "function") {
      throw new BridgeError("unavailable", "cannot revalidate the application screenshot before semantic point delivery", {
        details: { reason: "application_visual_preflight_unavailable" },
      });
    }
    const screenshotTimeoutSeconds = requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10);
    let captured;
    try {
      captured = await this.applications.captureApplication({
        application: observation.target.application,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        timeout_seconds: screenshotTimeoutSeconds,
      }, context);
    } catch (error) {
      if (applicationProcessIdentityError(error)) {
        throw staleSnapshot("application process instance changed before semantic point screenshot revalidation");
      }
      throw new BridgeError("unavailable", "cannot recapture the application window before semantic point delivery", {
        details: { reason: "application_visual_preflight_unavailable", detail: applicationScreenshotError(error) },
      });
    }
    const screenshot = captured?.screenshot;
    const data = screenshot?.source === "macos_window" && screenshot?.mime_type === "image/png" && typeof screenshot?.data === "string"
      ? screenshot.data : "";
    const digest = data ? createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") : "";
    const currentBinding = applicationWindowBinding(captured, digest);
    if (!sameApplicationWindowBinding(target.window_binding, currentBinding)) {
      throw staleSnapshot("application window identity, bounds, or screenshot changed before semantic point delivery");
    }
    const semantic = target.semantic_delivery;
    const inspection = applicationTargetInspection(target);
    let current;
    try {
      current = await this.applications.inspectApplication({
        application: observation.target.application,
        include_process_id: true,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        max_depth: inspection.max_depth,
        max_elements: 500,
        include_values: false,
        include_menus: inspection.include_menus,
        include_geometry: applicationTargetHasGeometry(target),
        timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10),
      }, context);
    } catch (error) {
      if (applicationProcessIdentityError(error)) {
        throw staleSnapshot("application process instance changed during semantic point preflight");
      }
      throw error;
    }
    try { validateApplicationInspectionEvidence(current); }
    catch { throw staleSnapshot("application Accessibility evidence became invalid during semantic point preflight"); }
    if (!applicationProcessIdentityMatches(current, expectedProcessId, expectedProcessGeneration)) {
      throw staleSnapshot("application process instance changed during semantic point preflight");
    }
    const matched = findApplicationMatch(current.elements, semantic.selector, semantic.occurrence);
    if (!matched) {
      throw staleSnapshot("application semantic point target is no longer present with the observed identity");
    }
    if (!applicationTargetGeometryMatches(matched, target)) {
      throw staleSnapshot("application semantic point target window or geometry changed before dispatch");
    }
    if (current.truncated === true) {
      throw staleSnapshot("application semantic point Accessibility coverage became incomplete before dispatch");
    }
    const livePointCandidates = currentApplicationSemanticPointCandidates(current.elements, target);
    if (livePointCandidates.length !== 1 || livePointCandidates[0] !== matched) {
      throw staleSnapshot("application semantic point no longer resolves uniquely to the same Accessibility target");
    }
    if (typeof this.applications.inspectApplicationWindow === "function") {
      const currentWindow = await this.applications.inspectApplicationWindow({
        application: observation.target.application,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        timeout_seconds: requiredComputerActRemainingTimeoutSeconds(actionDeadline, 10),
      }, context).catch(() => null);
      if (!sameApplicationWindowIdentity(target.window_binding, currentWindow)) {
        throw staleSnapshot("application window changed during semantic point preflight");
      }
    }
  }

  async dispatchBrowserDrag(observation, target, destination, args, context) {
    const inputMode = normalizeInputMode(args.input_mode);
    if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound drag requires trusted browser input");
    if (normalizeNavigationWait(args.wait_for) !== "none") {
      throw new BridgeError("invalid_request", "wait_for is not supported for drag; use expect.* post-conditions instead");
    }
    if (target?.kind === "point") {
      try {
        return await this.browser.pointAction({
          tab_id: observation.target.tab_id,
          action: "drag",
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          destination_normalized_x: destination.normalized_x,
          destination_normalized_y: destination.normalized_y,
          document_epoch: browserObservationSemanticEpoch(observation),
          viewport: target.viewport,
          screenshot_sha256: target.screenshot_sha256,
          screenshot_format: target.screenshot_format,
          screenshot_quality: target.screenshot_quality,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        const message = String(error?.message || error);
        if (message.includes("visual_snapshot_changed_before_dispatch")
            || message.includes("visual snapshot changed before trusted input; observe again")) {
          throw staleSnapshot("browser screenshot changed after the visual snapshot");
        }
        throw error;
      }
    }
    if (!target?.trusted_binding || !destination?.trusted_binding) {
      throw new BridgeError("unavailable", "snapshot-bound ref drag requires trusted backend bindings for both endpoints; observe with a screenshot and use point targets if needed", {
        details: { reason: "snapshot_backend_drag_unavailable" },
      });
    }
    try {
      return await this.browser.backendNodeAction({
        tab_id: observation.target.tab_id,
        action: "drag",
        backend_node_id: target.trusted_binding.backend_node_id,
        extension_frame_id: target.trusted_binding.extension_frame_id,
        frame_document_epoch: target.trusted_binding.extension_frame_epoch,
        frame_url: target.trusted_binding.extension_frame_url,
        extension_ref: target.ref,
        expected_ref_identity: browserSnapshotIdentity(target.element),
        destination_backend_node_id: destination.trusted_binding.backend_node_id,
        destination_extension_frame_id: destination.trusted_binding.extension_frame_id,
        destination_frame_document_epoch: destination.trusted_binding.extension_frame_epoch,
        destination_frame_url: destination.trusted_binding.extension_frame_url,
        destination_extension_ref: destination.ref,
        destination_expected_ref_identity: browserSnapshotIdentity(destination.element),
        document_epoch: browserObservationSemanticEpoch(observation),
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("snapshot backend target changed before trusted input; observe again")
          || message.includes("snapshot_backend_target_changed_before_dispatch")) {
        throw staleSnapshot("browser drag endpoint identity changed before trusted input");
      }
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) throw error;
      throw new BridgeError("unavailable", "snapshot-bound trusted drag is unavailable before dispatch", {
        cause: error instanceof Error ? error : undefined,
        details: { reason: "snapshot_backend_drag_unavailable" },
      });
    }
  }

  async dispatchBrowserScroll(observation, target, args, context) {
    const inputMode = normalizeInputMode(args.input_mode);
    if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound scroll requires trusted browser input");
    if (normalizeNavigationWait(args.wait_for) !== "none") {
      throw new BridgeError("invalid_request", "wait_for is not supported for scroll; use expect.* post-conditions instead");
    }
    const deltaX = browserScrollDelta(args.delta_x, "delta_x");
    const deltaY = browserScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "browser scroll requires a non-zero delta_x or delta_y");
    if (target?.kind === "point") {
      try {
        return await this.browser.pointAction({
          tab_id: observation.target.tab_id,
          action: "scroll",
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          delta_x: deltaX,
          delta_y: deltaY,
          document_epoch: browserObservationSemanticEpoch(observation),
          viewport: target.viewport,
          screenshot_sha256: target.screenshot_sha256,
          screenshot_format: target.screenshot_format,
          screenshot_quality: target.screenshot_quality,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        const message = String(error?.message || error);
        if (message.includes("visual_snapshot_changed_before_dispatch")
            || message.includes("visual snapshot changed before trusted input; observe again")) {
          throw staleSnapshot("browser screenshot changed after the visual snapshot");
        }
        throw error;
      }
    }
    if (!target?.trusted_binding) {
      throw new BridgeError("unavailable", "snapshot-bound ref scroll requires a trusted backend binding; observe with a screenshot and use a point target if needed", {
        details: { reason: "snapshot_backend_scroll_unavailable" },
      });
    }
    try {
      return await this.browser.backendNodeAction({
        tab_id: observation.target.tab_id,
        action: "scroll",
        backend_node_id: target.trusted_binding.backend_node_id,
        extension_frame_id: target.trusted_binding.extension_frame_id,
        frame_document_epoch: target.trusted_binding.extension_frame_epoch,
        frame_url: target.trusted_binding.extension_frame_url,
        extension_ref: target.ref,
        expected_ref_identity: browserSnapshotIdentity(target.element),
        document_epoch: browserObservationSemanticEpoch(observation),
        delta_x: deltaX,
        delta_y: deltaY,
        timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      }, context);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("snapshot backend target changed before trusted input; observe again")
          || message.includes("snapshot_backend_target_changed_before_dispatch")) {
        throw staleSnapshot("browser scroll anchor identity changed before trusted input");
      }
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) throw error;
      throw new BridgeError("unavailable", "snapshot-bound trusted scroll is unavailable before dispatch", {
        cause: error instanceof Error ? error : undefined,
        details: { reason: "snapshot_backend_scroll_unavailable" },
      });
    }
  }

  async dispatchBrowser(observation, privateState, action, target, args, context, destination = null) {
    if (action === "drag") return this.dispatchBrowserDrag(observation, target, destination, args, context);
    if (action === "scroll") return this.dispatchBrowserScroll(observation, target, args, context);
    if (target?.kind === "point") {
      const inputMode = normalizeInputMode(args.input_mode);
      if (inputMode === "dom") throw new BridgeError("invalid_request", "snapshot-bound visual point actions require trusted input");
      if (normalizeNavigationWait(args.wait_for) !== "none") {
        throw new BridgeError("invalid_request", "wait_for is not supported for visual point dispatch; use expect.load_state or another post-condition");
      }
      try {
        return await this.browser.pointAction({
          tab_id: observation.target.tab_id,
          action,
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          document_epoch: browserObservationSemanticEpoch(observation),
          viewport: target.viewport,
          screenshot_sha256: target.screenshot_sha256,
          screenshot_format: target.screenshot_format,
          screenshot_quality: target.screenshot_quality,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        const message = String(error?.message || error);
        if (message.includes("visual_snapshot_changed_before_dispatch")
            || message.includes("visual snapshot changed before trusted input; observe again")) {
          throw staleSnapshot("browser screenshot changed after the visual snapshot");
        }
        throw error;
      }
    }
    const inputMode = normalizeInputMode(args.input_mode);
    const navigationWait = normalizeNavigationWait(args.wait_for);
    const boundResult = await trySnapshotBoundBackendAction({
      browser: this.browser,
      observation,
      action,
      target,
      args,
      context,
      inputMode,
      navigationWait,
    });
    if (boundResult) return boundResult;
    const call = {
      tab_id: observation.target.tab_id,
      action,
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      wait_for: navigationWait,
      input_mode: inputMode,
      element_timeout_seconds: clampInt(args.element_timeout_seconds, 10, 1, 60),
    };
    if (target) {
      call.frame_id = target.frame_id;
      call.selector = { ref: target.ref };
      call.expected_ref_identity = browserSnapshotIdentity(target.element);
    }
    if (BROWSER_TARGETLESS_ACTIONS.has(action)) {
      const expectedTabUrl = typeof observation.target?.url === "string" ? observation.target.url : "";
      if (expectedTabUrl) call.expected_tab_url = expectedTabUrl;
    }
    if (BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS.has(action)) {
      const semanticEpoch = browserObservationSemanticEpoch(observation);
      const historyEntryKey = privateBrowserHistoryEntryKey(privateState?.browser_history_entry_key);
      if (semanticEpoch) call.expected_document_epoch = semanticEpoch;
      if (historyEntryKey) call.expected_history_entry_key = historyEntryKey;
    }
    if (action === "navigate") call.url = requiredString(args.url, "url", 32768);
    if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 131072);
    if (args.value_resource !== undefined) call.value_resource = requiredResource(args.value_resource);
    if (args.key !== undefined) call.key = requiredString(args.key, "key", 100);
    try {
      return await this.browser.act(call, context);
    } catch (error) {
      throw browserSnapshotDispatchError(error);
    }
  }

  async dispatchApplication(observation, privateState, action, target, args, context, destination = null) {
    const expectedProcessId = requiredPrivateApplicationProcessId(privateState?.application_process_id);
    const expectedProcessGeneration = requiredPrivateApplicationProcessGeneration(privateState?.application_process_generation);
    if (target?.kind === "point") {
      if (action === "drag") {
        try {
          return await this.applications.dragApplication({
            application: observation.target.application,
            expected_process_id: expectedProcessId,
            expected_process_generation: expectedProcessGeneration,
            normalized_x: target.normalized_x,
            normalized_y: target.normalized_y,
            destination_normalized_x: destination.normalized_x,
            destination_normalized_y: destination.normalized_y,
            window_id: target.window_binding.window_id,
            bounds: target.window_binding.bounds,
            screenshot_sha256: target.window_binding.screenshot_sha256,
            timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
          }, context);
        } catch (error) {
          throw applicationVisualDispatchError(error, {
            staleDetail: "application window identity, bounds, or screenshot changed immediately before visual drag",
            processDetail: "application process changed immediately before visual drag",
            unavailableMessage: "application visual drag could not be validated before dispatch",
          });
        }
      }
      if (action === "scroll") {
        try {
          return await this.applications.scrollApplication({
            application: observation.target.application,
            expected_process_id: expectedProcessId,
            expected_process_generation: expectedProcessGeneration,
            normalized_x: target.normalized_x,
            normalized_y: target.normalized_y,
            delta_x: args.delta_x,
            delta_y: args.delta_y,
            window_id: target.window_binding.window_id,
            bounds: target.window_binding.bounds,
            screenshot_sha256: target.window_binding.screenshot_sha256,
            timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
          }, context);
        } catch (error) {
          throw applicationVisualDispatchError(error, {
            staleDetail: "application window identity, bounds, or screenshot changed immediately before visual scroll",
            processDetail: "application process changed immediately before visual scroll",
            unavailableMessage: "application visual scroll could not be validated before dispatch",
          });
        }
      }
      if (target.semantic_delivery) {
        const semantic = target.semantic_delivery;
        const selector = semantic.occurrence > 0 ? { ...semantic.selector, index: semantic.occurrence } : semantic.selector;
        const inspection = applicationTargetInspection(target);
        const call = applyApplicationTargetGeometry({
          application: observation.target.application,
          expected_process_id: expectedProcessId,
          expected_process_generation: expectedProcessGeneration,
          action: "click",
          selector,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
          include_menus: inspection.include_menus,
          max_depth: inspection.max_depth,
        }, target);
        const result = await this.operateApplicationBound(call, context);
        return {
          ...result,
          coordinate_source: "accessibility_point_resolution",
          window_bound: true,
          screenshot_revalidated: true,
          normalized_point: { x: target.normalized_x, y: target.normalized_y },
          semantic_point_candidates: target.semantic_point_candidates,
        };
      }
      try {
        const result = await this.applications.pointApplication({
          application: observation.target.application,
          expected_process_id: expectedProcessId,
          expected_process_generation: expectedProcessGeneration,
          normalized_x: target.normalized_x,
          normalized_y: target.normalized_y,
          ...(action === "double_click" ? { click_count: 2 } : {}),
          window_id: target.window_binding.window_id,
          bounds: target.window_binding.bounds,
          screenshot_sha256: target.window_binding.screenshot_sha256,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
        return { ...result, semantic_point_candidates: target.semantic_point_candidates };
      } catch (error) {
        throw applicationVisualDispatchError(error, {
          staleDetail: "application window identity, bounds, or screenshot changed immediately before visual dispatch",
          processDetail: "application process changed immediately before visual dispatch",
          unavailableMessage: "application visual input could not be validated before dispatch",
        });
      }
    }
    const inspection = applicationTargetInspection(target);
    const call = {
      application: observation.target.application,
      expected_process_id: expectedProcessId,
      expected_process_generation: expectedProcessGeneration,
      action,
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
      include_menus: inspection.include_menus,
      max_depth: inspection.max_depth,
    };
    if (target) call.selector = target.occurrence > 0 ? { ...target.selector, index: target.occurrence } : target.selector;
    if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 4000);
    if (args.value_resource !== undefined) call.value_resource = requiredResource(args.value_resource);
    if (args.key !== undefined) call.key = requiredString(args.key, "key", 100);
    if (action === "set_value" && args.value_resource !== undefined && target?.element?.sensitive !== true) {
      call.retain_value_verification = true;
    }
    return this.operateApplicationBound(applyApplicationTargetGeometry(call, target), context);
  }

  async operateApplicationBound(call, context) {
    try {
      return await this.applications.operateApplication(call, context);
    } catch (error) {
      const reason = applicationOperationReason(error);
      if (reason === APPLICATION_OPERATION_REASON.TARGET_GEOMETRY_CHANGED
          || reason === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) {
        throw staleSnapshot("application target window or geometry changed immediately before Accessibility dispatch");
      }
      if (reason === APPLICATION_OPERATION_REASON.CHECKED_STATE_CHANGED) {
        throw staleSnapshot("application checked-state target changed immediately before Accessibility dispatch");
      }
      if (reason === APPLICATION_OPERATION_REASON.CHECKED_STATE_INPUT_UNAVAILABLE) {
        throw new BridgeError("unavailable", "application checked-state input is unavailable before dispatch", {
          details: { reason: "application_checked_state_input_unavailable" },
        });
      }
      throw error;
    }
  }

  async verifyApplicationPostAction({
    beforeObservation,
    beforePrivateState,
    target,
    expectation,
    args,
    dispatchResult,
    captureArgs,
    timeoutSeconds,
    operationDeadline = null,
  }, context) {
    const deadline = createMonotonicDeadline(timeoutSeconds * 1000, this.now);
    const retainedHandle = typeof dispatchResult?._machine_value_verification_handle === "string"
      ? dispatchResult._machine_value_verification_handle : "";
    let postCapture = null;
    let postCaptureError = "";
    let observedDiff = null;
    let captureAttempts = 0;
    let verificationProbe = { requested: true, matched: false, reason: "not_checked" };
    try {
      for (;;) {
        const remainingBeforeCaptureMs = deadline.remainingMs();
        if (remainingBeforeCaptureMs <= 0 || captureAttempts >= APPLICATION_VERIFY_MAX_CAPTURES) {
          if (postCaptureError) verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
        try { this.throwIfCancelled(context); }
        catch (error) {
          postCaptureError = publicPostObservationError("application", error);
          verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
        let captured = null;
        let captureError = "";
        const configuredCaptureTimeoutSeconds = clampInt(captureArgs.timeout_seconds, 30, 1, 60);
        const operationTimeoutSeconds = computerActRemainingTimeoutSeconds(operationDeadline, configuredCaptureTimeoutSeconds);
        const captureTimeoutSeconds = Math.min(
          Math.max(1, Math.min(configuredCaptureTimeoutSeconds, Math.ceil(remainingBeforeCaptureMs / 1000))),
          operationTimeoutSeconds,
        );
        if (operationTimeoutSeconds <= 0) {
          if (!postCapture) {
            postCaptureError = computerActPostObservationTimeoutError("application");
            verificationProbe = computerActVerificationTimeoutProbe();
          }
          break;
        }
        captureAttempts += 1;
        try { captured = await this.capture({ ...captureArgs, timeout_seconds: captureTimeoutSeconds }, context, operationDeadline); }
        catch (error) {
          captureError = publicPostObservationError("application", error);
          if (errorCode(error) === "cancelled") {
            postCaptureError = captureError;
            verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
            break;
          }
        }
        if (captured) {
          if (postCapture) this.snapshots.discard(postCapture.observation.snapshot_id);
          postCapture = captured;
          postCaptureError = "";
          observedDiff = observationDiff(beforeObservation, captured.observation, beforePrivateState, captured.privateState);
          const processChanged = applicationProcessChanged(beforePrivateState, captured.privateState) === true;
          let valueProbe = null;
          if (expectation.target_value_matches !== undefined) {
            const remainingValueVerificationMs = deadline.remainingMs();
            const operationValueTimeoutSeconds = computerActRemainingTimeoutSeconds(operationDeadline, 60);
            const valueTimeoutSeconds = Math.min(Math.max(1, Math.ceil(remainingValueVerificationMs / 1000)), operationValueTimeoutSeconds);
            valueProbe = processChanged
              ? { available: false, matched: false, reason: "application_process_changed" }
              : remainingValueVerificationMs <= 0 || operationValueTimeoutSeconds <= 0
                ? { available: false, matched: false, reason: "verification_deadline_elapsed" }
                : await this.verifyApplicationValueExpectation(
                    captured, target, args, dispatchResult, context,
                    valueTimeoutSeconds,
                  );
          }
          verificationProbe = verifyApplicationExpectation(
            { after: captured.observation, target, expectation, diff: observedDiff,
              processChanged: applicationProcessChanged(beforePrivateState, captured.privateState),
              findTarget: (verificationTarget) => findPostApplicationTarget(captured.observation, captured.privateState, verificationTarget),
              valueProbe },
          );
          if (verificationProbe.matched === true || processChanged) break;
          if (expectation.target_value_matches !== undefined
              && valueProbe?.reason !== "post_target_binding_unavailable"
              && !(valueProbe?.reason === "value_readback_failed" && args.value !== undefined)) break;
        } else {
          postCaptureError = captureError;
        }
        const remainingMs = Math.min(
          deadline.remainingMs(),
          operationDeadline?.remainingMs?.() ?? Number.POSITIVE_INFINITY,
        );
        if (remainingMs <= 0 || captureAttempts >= APPLICATION_VERIFY_MAX_CAPTURES) {
          if (postCaptureError) verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
        const retryDelayMs = APPLICATION_VERIFY_POLL_MS * (2 ** Math.min(Math.max(captureAttempts - 1, 0), 3));
        try { await this.sleep(Math.min(retryDelayMs, remainingMs)); }
        catch (error) {
          postCaptureError = publicPostObservationError("application", error);
          verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
      }
    } catch (error) {
      postCaptureError = publicPostObservationError("application", error);
      verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
    } finally {
      this.discardApplicationValueVerification(retainedHandle);
    }
    return { postCapture, postCaptureError, observedDiff, verificationProbe };
  }

  async verifyApplicationValueExpectation(postCapture, target, args, dispatchResult, context, remainingTimeoutSeconds) {
    if (typeof this.applications.verifyApplicationValue !== "function") {
      return { available: false, matched: false, reason: "value_readback_backend_unavailable" };
    }
    const verificationTarget = applicationVerificationTarget(target);
    const postTarget = verificationTarget
      ? findPostApplicationTargetBinding(postCapture.observation, postCapture.privateState, verificationTarget)
      : null;
    if (!postTarget) return { available: false, matched: false, reason: "post_target_binding_unavailable" };
    if (postTarget.element?.sensitive === true) return { available: false, matched: false, reason: "sensitive_target" };
    const inspection = postCapture.privateState?.application_inspection || null;
    const selector = postTarget.binding.occurrence > 0
      ? { ...postTarget.binding.selector, index: postTarget.binding.occurrence }
      : postTarget.binding.selector;
    const call = applyApplicationTargetGeometry({
      application: postCapture.observation.target.application,
      expected_process_id: requiredPrivateApplicationProcessId(postCapture.privateState?.application_process_id),
      expected_process_generation: requiredPrivateApplicationProcessGeneration(postCapture.privateState?.application_process_generation),
      selector,
      max_depth: clampInt(inspection?.max_depth, 6, 1, 12),
      include_menus: inspection?.include_menus === true,
      timeout_seconds: Math.min(
        clampInt(args.timeout_seconds, 30, 1, 60),
        clampInt(remainingTimeoutSeconds, 1, 1, 60),
      ),
    }, {
      owner_window_bounds: postTarget.binding.owner_window_bounds || null,
      screen_box: postTarget.binding.screen_box || null,
    });
    const retainedHandle = typeof dispatchResult?._machine_value_verification_handle === "string"
      ? dispatchResult._machine_value_verification_handle : "";
    if (retainedHandle) call.value_verification_handle = retainedHandle;
    else if (args.value !== undefined) call.value = requiredStringAllowEmpty(args.value, "value", 4000);
    else if (args.value_resource !== undefined) {
      return { available: false, matched: false, reason: "exact_dispatched_resource_value_unavailable" };
    }
    try {
      const result = await this.applications.verifyApplicationValue(call, context);
      if (result?.supported !== true) return { available: false, matched: false, reason: String(result?.reason || "value_readback_unsupported") };
      return { available: true, matched: result.matched === true, reason: "accessibility_value_compared" };
    } catch {
      return { available: false, matched: false, reason: "value_readback_failed" };
    }
  }

  discardApplicationValueVerification(handle) {
    if (!handle || typeof this.applications.discardApplicationValueVerification !== "function") return;
    try { this.applications.discardApplicationValueVerification(handle); }
    catch { /* TTL remains the fallback if best-effort cleanup cannot run. */ }
  }

  async verifyBrowserExpectation(observation, target, expectation, timeoutSeconds, context) {
    const waitArgs = { tab_id: observation.target.tab_id, timeout_seconds: timeoutSeconds };
    let hasWaitCondition = false;
    const postCheckPending = browserExpectationNeedsPostObservation(expectation);
    if (expectation.url_contains) { waitArgs.url_contains = expectation.url_contains; hasWaitCondition = true; }
    if (expectation.text) { waitArgs.text = expectation.text; hasWaitCondition = true; }
    if (expectation.load_state) { waitArgs.load_state = expectation.load_state; hasWaitCondition = true; }
    if (expectation.target_state) {
      if (!target || target.kind !== "ref") return { requested: true, matched: false, reason: "target_state_requires_ref_target" };
      waitArgs.frame_id = target.frame_id;
      waitArgs.selector = { ref: target.ref };
      waitArgs.state = expectation.target_state;
      hasWaitCondition = true;
    }
    if (!hasWaitCondition) {
      return postCheckPending
        ? { requested: true, matched: false, wait_matched: true, post_check_pending: true, reason: "post_conditions_pending" }
        : { requested: true, matched: true, wait_matched: true, reason: "no_wait_conditions" };
    }
    try {
      await this.browser.wait(waitArgs, context);
      return postCheckPending
        ? { requested: true, matched: false, wait_matched: true, post_check_pending: true, reason: "post_conditions_pending" }
        : { requested: true, matched: true, wait_matched: true, reason: "wait_conditions_satisfied" };
    } catch (error) {
      return {
        requested: true,
        matched: false,
        wait_matched: false,
        post_check_pending: postCheckPending,
        reason: "wait_conditions_not_observed",
        error_class: errorCode(error),
      };
    }
  }
}
