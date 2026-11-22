import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { applicationPointTarget, applicationPostFocusQuery, applicationTargetGeometryMatches, applicationTargetHasGeometry, applicationTargetInspection, browserSnapshotIdentityMatches, defaultSleep, staleSnapshot } from "./computer-use-geometry.mjs";
import { clampInt, normalizeApplicationAction, normalizeBrowserAction, normalizePostObservationDetail, normalizePostScreenshotPolicy, requiredSnapshotId, requiredSurface, requiredTargetRef, shouldIncludePostScreenshot, validateActionDispatchArguments, validateDragTargets, validateSurfaceActionArgs, settleComputerUseDispatch, ComputerUseSnapshotStore } from "./computer-use-contracts.mjs";
import { captureApplicationObservation, captureApplicationScreenshot, captureBrowserObservation, captureComputerUse, revalidateApplicationWindow } from "./computer-use-capture.mjs";
import { computerActPostObservationTimeoutError, computerActRemainingTimeoutSeconds, computerActVerificationTimeoutProbe, publicPostObservationError, requiredComputerActRemainingTimeoutSeconds, applicationStateActionTargetSupported, normalizeExpectation, validateApplicationStateActionTarget, validateExpectationPrerequisites, validateApplicationInspectionEvidence, buildRetryGuidance } from "./computer-use-policies.mjs";
import { BROWSER_TARGETLESS_ACTIONS, dispatchApplicationAction, dispatchBrowserAction, dispatchBrowserDrag, dispatchBrowserScroll, operateApplicationBound, preflightApplicationSemanticPoint, preflightBrowserTarget } from "./computer-use-dispatch.mjs";
import { applicationProcessIdentityError, applicationProcessIdentityMatches, browserPointTarget, browserPostFocusQuery, browserSnapshotIdentity, findApplicationMatch, isVisualPointTarget, requiredPrivateApplicationProcessGeneration, requiredPrivateApplicationProcessId, sanitizeDispatchResult, classifyEffectStatus, combineBrowserPostChecks } from "./computer-use-verification.mjs";
import { buildContinuation, observationDiff, projectPostObservation } from "./computer-use-observation.mjs";
import { RESULT_BUDGET_OMISSION_REASON, fitActionResultToBudget, observationResult } from "./computer-use-result-budget.mjs";
import { discardApplicationValueVerification, verifyApplicationPostAction, verifyApplicationValueExpectation, verifyBrowserExpectation } from "./computer-use-verify.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";

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

  capture(args, context, operationDeadline = null) {
    return captureComputerUse(this, args, context, operationDeadline);
  }

  captureApplicationScreenshot(params, context) {
    return captureApplicationScreenshot(this, params, context);
  }

  captureBrowser(args, context) {
    return captureBrowserObservation(this, args, context);
  }

  captureApplication(args, context, operationDeadline = null) {
    return captureApplicationObservation(this, args, context, operationDeadline);
  }

  revalidateApplicationWindow(params) {
    return revalidateApplicationWindow(this, params);
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

  preflightBrowser(observation, privateState, action, target, context, actionDeadline = null) {
    return preflightBrowserTarget(this, observation, privateState, action, target, context, actionDeadline);
  }

  preflightApplicationSemanticPoint(
    observation, target, expectedProcessId, expectedProcessGeneration, context, actionDeadline = null,
  ) {
    return preflightApplicationSemanticPoint(
      this, observation, target, expectedProcessId, expectedProcessGeneration, context, actionDeadline,
    );
  }

  dispatchBrowserDrag(observation, target, destination, args, context) {
    return dispatchBrowserDrag(this, observation, target, destination, args, context);
  }

  dispatchBrowserScroll(observation, target, args, context) {
    return dispatchBrowserScroll(this, observation, target, args, context);
  }

  dispatchBrowser(observation, privateState, action, target, args, context, destination = null) {
    return dispatchBrowserAction(this, observation, privateState, action, target, args, context, destination);
  }

  dispatchApplication(observation, privateState, action, target, args, context, destination = null) {
    return dispatchApplicationAction(this, observation, privateState, action, target, args, context, destination);
  }

  operateApplicationBound(call, context) {
    return operateApplicationBound(this, call, context);
  }

  verifyApplicationPostAction(params, context) {
    return verifyApplicationPostAction(this, params, context);
  }

  verifyApplicationValueExpectation(postCapture, target, args, dispatchResult, context, remainingTimeoutSeconds) {
    return verifyApplicationValueExpectation(this, postCapture, target, args, dispatchResult, context, remainingTimeoutSeconds);
  }

  discardApplicationValueVerification(handle) {
    discardApplicationValueVerification(this, handle);
  }

  verifyBrowserExpectation(observation, target, expectation, timeoutSeconds, context) {
    return verifyBrowserExpectation(this, observation, target, expectation, timeoutSeconds, context);
  }
}
