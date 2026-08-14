import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BridgeError, errorCode } from "./errors.mjs";
import { ComputerUseSnapshotStore } from "./computer-use-snapshot-store.mjs";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { buildBrowserObservation, buildContinuation, extractBrowserPrivateBindings, observationDiff, projectPostObservation } from "./computer-use-observation.mjs";
import { buildRetryGuidance } from "./computer-use-recovery.mjs";
import { applicationElementSupportsPointClick, applicationMatchesSelector, prepareApplicationObservationElements } from "./computer-use-application-observation.mjs";
import {
  assertObservationResultFits, fitActionResultToBudget, isResultLimitExceeded, RESULT_BUDGET_OMISSION_REASON,
  observationResult, omitApplicationScreenshotForResultBudget, omitBrowserScreenshotForResultBudget,
} from "./computer-use-result-budget.mjs";

const BROWSER_ACTIONS = new Set([
  "navigate", "reload", "back", "forward", "click", "double_click", "hover", "drag", "scroll", "fill", "type_text",
  "select", "check", "uncheck", "focus", "press", "submit", "scroll_into_view",
]);
const BROWSER_TARGETLESS_ACTIONS = new Set(["navigate", "reload", "back", "forward"]);
const BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS = new Set(["reload", "back", "forward"]);
const BROWSER_POINT_ACTIONS = new Set(["click", "double_click", "hover", "drag", "scroll"]);
const BROWSER_BACKEND_TRUSTED_ACTIONS = new Set(["click", "double_click", "hover", "press", "type_text", "fill", "check", "uncheck", "submit"]);
const BROWSER_BACKEND_TEXT_ACTIONS = new Set(["type_text", "fill"]);
const BROWSER_SNAPSHOT_IDENTITY_FIELDS = Object.freeze([
  "tag", "type", "role", "name", "id", "field_name", "label", "placeholder", "href", "sensitive", "in_shadow_dom",
]);
const BROWSER_SNAPSHOT_BOOLEAN_IDENTITY_FIELDS = new Set(["sensitive", "in_shadow_dom"]);
const APPLICATION_ACTIONS = new Set(["activate", "click", "double_click", "drag", "scroll", "check", "uncheck", "set_value", "focus", "press", "keystroke", "key_press"]);
const BROWSER_STATES = new Set(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"]);
const BROWSER_LOAD_STATES = new Set(["domcontentloaded", "complete"]);
const INPUT_MODES = new Set(["auto", "trusted", "dom"]);
const NAVIGATION_WAITS = new Set(["none", "domcontentloaded", "complete"]);
const APPLICATION_VERIFY_POLL_MS = 100;
const APPLICATION_VERIFY_MAX_CAPTURES = 9;
const MAX_APPLICATION_OBSERVATION_ELEMENTS = 500;
const MAX_APPLICATION_SCREENSHOT_BYTES = 32 * 1024 * 1024;

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
    await this.preflight(snapshot.observation, snapshot.privateState, surface, action, target, context);
    if (destination) await this.preflight(snapshot.observation, snapshot.privateState, surface, action, destination, context);
    this.snapshots.claim(snapshotId, snapshot);

    let dispatchStatus = "completed";
    let dispatchResult = null;
    let dispatchError = "";
    try {
      dispatchResult = surface === "browser"
        ? await this.dispatchBrowser(snapshot.observation, snapshot.privateState, action, target, args, context, destination)
        : await this.dispatchApplication(snapshot.observation, snapshot.privateState, action, target, args, context, destination);
    } catch (error) {
      if (!isUnknownOutcomeError(error)) throw error;
      dispatchStatus = "unknown";
      dispatchError = boundedError(error);
    }

    let verificationProbe = { requested: Boolean(expectation), matched: false, reason: expectation ? "not_checked" : "not_requested" };
    if (surface === "browser" && expectation) {
      verificationProbe = await this.verifyBrowserExpectation(
        snapshot.observation,
        target,
        expectation,
        verifyTimeoutSeconds,
        context,
      );
    }

    const includePostScreenshot = shouldIncludePostScreenshot(postScreenshotPolicy, { surface, target, expectation, dispatchStatus });
    const applicationPostArgs = surface === "application" ? {
      surface,
      application: snapshot.observation.target.application,
      include_screenshot: includePostScreenshot,
      max_elements: clampInt(args.post_max_elements, 200, 1, 500),
      max_depth: clampInt(args.post_max_depth, 6, 1, 12),
      include_values: false,
      include_menus: args.include_menus === true,
      focus_query: applicationPostFocusQuery(target),
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    } : null;
    let postCapture = null;
    let postCaptureError = "";
    let observedDiff = null;
    if (surface === "application" && expectation) {
      const verified = await this.verifyApplicationPostAction({
        beforeObservation: snapshot.observation,
        beforePrivateState: snapshot.privateState,
        target,
        expectation,
        args,
        dispatchResult,
        captureArgs: applicationPostArgs,
        timeoutSeconds: verifyTimeoutSeconds,
      }, context);
      postCapture = verified.postCapture;
      postCaptureError = verified.postCaptureError;
      observedDiff = verified.observedDiff;
      verificationProbe = verified.verificationProbe;
    } else {
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
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        } : applicationPostArgs, context);
      } catch (error) {
        postCaptureError = boundedError(error);
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

  async capture(args, context) {
    const surface = requiredSurface(args.surface);
    validateObserveArgs(surface, args);
    if (surface === "browser") return this.captureBrowser(args, context);
    return this.captureApplication(args, context);
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

  async captureApplication(args, context) {
    const application = requiredString(args.application, "application", 300);
    const maxElements = clampInt(args.max_elements, 200, 1, 500);
    const maxDepth = clampInt(args.max_depth, 6, 1, 12);
    const includeValues = optionalBoolean(args.include_values, "include_values", false);
    const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
    const focusQuery = optionalApplicationFocusQuery(args.focus_query);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 60);
    const screenshotRequested = optionalBoolean(args.include_screenshot, "include_screenshot", true);
    let screenshot = null;
    let screenshotError = "";
    if (screenshotRequested && typeof this.applications.captureApplication === "function") {
      try {
        screenshot = await this.applications.captureApplication({
          application,
          timeout_seconds: timeoutSeconds,
        }, context);
      } catch (error) {
        screenshotError = applicationScreenshotError(error);
      }
    }
    const screenshotPayload = screenshot?.screenshot;
    const screenshotBytes = screenshotPayload?.mime_type === "image/png"
      ? applicationScreenshotBytes(screenshotPayload?.data) : null;
    const image = screenshotBytes ? { type: "image", data: screenshotPayload.data, mimeType: "image/png" } : null;
    const screenshotSource = image && typeof screenshotPayload?.source === "string" ? screenshotPayload.source : image ? "unknown" : "none";
    const screenshotSha256 = screenshotBytes ? createHash("sha256").update(screenshotBytes).digest("hex") : "";
    const windowBinding = applicationWindowBinding(screenshot, screenshotSha256);
    const screenshotProcessId = optionalPrivateApplicationProcessId(screenshot?._machine_process_id);
    const screenshotProcessGeneration = optionalPrivateApplicationProcessGeneration(screenshot?._machine_process_generation);
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
      timeout_seconds: timeoutSeconds,
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
      context,
    });
    const visualPointCapability = typeof this.applications.visualPointCapability === "function"
      ? this.applications.visualPointCapability()
      : { available: typeof this.applications.pointApplication === "function", backend: "test-or-legacy", experimental: false };
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
    application, windowBinding, inspected, applicationProcessId, applicationProcessGeneration, timeoutSeconds, context,
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
    try {
      const currentWindow = await this.applications.inspectApplicationWindow({
        application,
        expected_process_id: applicationProcessId,
        expected_process_generation: applicationProcessGeneration,
        timeout_seconds: timeoutSeconds,
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

  async preflight(observation, privateState, surface, action, target, context) {
    if (surface === "browser") return this.preflightBrowser(observation, privateState, action, target, context);

    const expectedProcessId = requiredPrivateApplicationProcessId(privateState?.application_process_id);
    const expectedProcessGeneration = requiredPrivateApplicationProcessGeneration(privateState?.application_process_generation);
    if (action === "activate") return;
    if (target?.kind === "point") {
      if (target.semantic_delivery) {
        await this.preflightApplicationSemanticPoint(observation, target, expectedProcessId, expectedProcessGeneration, context);
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
        timeout_seconds: 10,
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

  async preflightBrowser(observation, privateState, action, target, context) {
    const tabs = await this.browser.listTabs({ include_pinned: true, timeout_seconds: 5 }, context);
    const tab = (tabs.tabs || []).find((item) => item.id === observation.target.tab_id || item.tab_id === observation.target.tab_id);
    if (!tab) throw staleSnapshot("browser tab no longer exists");
    const tabUrl = typeof tab.url === "string" ? tab.url : "";
    const snapshotUrl = typeof observation.target.url === "string" ? observation.target.url : "";
    if (!tabUrl || !snapshotUrl || tabUrl !== snapshotUrl) throw staleSnapshot("browser tab navigated after the snapshot");
    const semanticEpoch = typeof observation.capture?.semantic_epoch === "string" ? observation.capture.semantic_epoch : "";
    let currentDocument = null;
    let documentStateError = null;
    if (semanticEpoch && typeof this.browser.documentState === "function") {
      try {
        currentDocument = await this.browser.documentState({ tab_id: observation.target.tab_id, timeout_seconds: 5 }, context);
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
          details: { reason: "visual_preflight_unavailable", detail: boundedError(documentStateError) },
        });
      }
      if (!sameVisualViewport(target.viewport, currentDocument.viewport)) throw staleSnapshot("browser viewport changed after the screenshot");
    } else if (target) {
      try {
        await this.browser.wait({
          tab_id: observation.target.tab_id,
          frame_id: target.frame_id,
          selector: { ref: target.ref },
          state: "attached",
          timeout_seconds: 1,
        }, context);
      } catch {
        throw staleSnapshot("browser target ref is no longer attached");
      }
    }
  }

  async preflightApplicationSemanticPoint(observation, target, expectedProcessId, expectedProcessGeneration, context) {
    if (typeof this.applications.captureApplication !== "function") {
      throw new BridgeError("unavailable", "cannot revalidate the application screenshot before semantic point delivery", {
        details: { reason: "application_visual_preflight_unavailable" },
      });
    }
    let captured;
    try {
      captured = await this.applications.captureApplication({
        application: observation.target.application,
        expected_process_id: expectedProcessId,
        expected_process_generation: expectedProcessGeneration,
        timeout_seconds: 10,
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
        timeout_seconds: 10,
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
        timeout_seconds: 10,
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
          const message = String(error?.message || error);
          if (message.includes("application visual snapshot is stale") || message.includes("application visual snapshot changed before dispatch")) {
            throw staleSnapshot("application window identity, bounds, or screenshot changed immediately before visual drag");
          }
          if (applicationProcessIdentityError(error)) {
            throw staleSnapshot("application process changed immediately before visual drag");
          }
          if (message.includes("application visual snapshot unavailable before dispatch") || message.includes("application visual input unavailable before dispatch")) {
            throw new BridgeError("unavailable", "application visual drag could not be validated before dispatch", {
              details: { reason: "application_visual_preflight_unavailable" },
            });
          }
          throw error;
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
          const message = String(error?.message || error);
          if (message.includes("application visual snapshot is stale") || message.includes("application visual snapshot changed before dispatch")) {
            throw staleSnapshot("application window identity, bounds, or screenshot changed immediately before visual scroll");
          }
          if (applicationProcessIdentityError(error)) {
            throw staleSnapshot("application process changed immediately before visual scroll");
          }
          if (message.includes("application visual snapshot unavailable before dispatch") || message.includes("application visual input unavailable before dispatch")) {
            throw new BridgeError("unavailable", "application visual scroll could not be validated before dispatch", {
              details: { reason: "application_visual_preflight_unavailable" },
            });
          }
          throw error;
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
        const message = String(error?.message || error);
        if (message.includes("application visual snapshot is stale") || message.includes("application visual snapshot changed before dispatch")) {
          throw staleSnapshot("application window identity, bounds, or screenshot changed immediately before visual dispatch");
        }
        if (applicationProcessIdentityError(error)) {
          throw staleSnapshot("application process changed immediately before visual dispatch");
        }
        if (message.includes("application visual snapshot unavailable before dispatch") || message.includes("application visual input unavailable before dispatch")) {
          throw new BridgeError("unavailable", "application visual input could not be validated before dispatch", {
            details: { reason: "application_visual_preflight_unavailable" },
          });
        }
        throw error;
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
      const message = String(error?.message || error);
      if (message.includes("application target window changed before dispatch")
          || message.includes("application target geometry changed before dispatch")
          || applicationProcessIdentityError(error)) {
        throw staleSnapshot("application target window or geometry changed immediately before Accessibility dispatch");
      }
      if (message.includes("application target checked state is unavailable before dispatch")
          || message.includes("application check target is not an Accessibility checkbox or radio button")
          || message.includes("application uncheck target is not an Accessibility checkbox")) {
        throw staleSnapshot("application checked-state target changed immediately before Accessibility dispatch");
      }
      if (message.includes("application target does not expose AXPress before checked-state dispatch")) {
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
          postCaptureError = boundedError(error);
          verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
        let captured = null;
        let captureError = "";
        const configuredCaptureTimeoutSeconds = clampInt(captureArgs.timeout_seconds, 30, 1, 60);
        const captureTimeoutSeconds = captureAttempts === 0
          ? configuredCaptureTimeoutSeconds
          : Math.max(1, Math.min(configuredCaptureTimeoutSeconds, Math.ceil(remainingBeforeCaptureMs / 1000)));
        captureAttempts += 1;
        try { captured = await this.capture({ ...captureArgs, timeout_seconds: captureTimeoutSeconds }, context); }
        catch (error) {
          captureError = boundedError(error);
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
            valueProbe = processChanged
              ? { available: false, matched: false, reason: "application_process_changed" }
              : remainingValueVerificationMs <= 0
                ? { available: false, matched: false, reason: "verification_deadline_elapsed" }
                : await this.verifyApplicationValueExpectation(
                    captured, target, args, dispatchResult, context,
                    Math.max(1, Math.ceil(remainingValueVerificationMs / 1000)),
                  );
          }
          verificationProbe = verifyApplicationExpectation(
            beforeObservation,
            captured.observation,
            target,
            expectation,
            observedDiff,
            beforePrivateState,
            captured.privateState,
            valueProbe,
          );
          if (verificationProbe.matched === true || processChanged) break;
          if (expectation.target_value_matches !== undefined
              && valueProbe?.reason !== "post_target_binding_unavailable"
              && !(valueProbe?.reason === "value_readback_failed" && args.value !== undefined)) break;
        } else {
          postCaptureError = captureError;
        }
        const remainingMs = deadline.remainingMs();
        if (remainingMs <= 0 || captureAttempts >= APPLICATION_VERIFY_MAX_CAPTURES) {
          if (postCaptureError) verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
        const retryDelayMs = APPLICATION_VERIFY_POLL_MS * (2 ** Math.min(Math.max(captureAttempts - 1, 0), 3));
        try { await this.sleep(Math.min(retryDelayMs, remainingMs)); }
        catch (error) {
          postCaptureError = boundedError(error);
          verificationProbe = { ...verificationProbe, matched: false, inconclusive: true, reason: "post_conditions_inconclusive" };
          break;
        }
      }
    } catch (error) {
      postCaptureError = boundedError(error);
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
        detail: boundedError(error),
      };
    }
  }
}

function validateExpectationPrerequisites(expectation, observation, postScreenshotPolicy) {
  if (!expectation || expectation.visual_change === undefined) return;
  if (!observation.capture?.screenshot_sha256) {
    throw new BridgeError("invalid_request", "expect.visual_change requires the referenced computer snapshot to include a screenshot");
  }
  if (postScreenshotPolicy === "never") {
    throw new BridgeError("invalid_request", "expect.visual_change requires post_screenshot=auto or always");
  }
}

function normalizeExpectation(surface, action, target, raw) {
  let value = raw === undefined || raw === null ? defaultExpectation(surface, action, target) : raw;
  if (!value) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid_request", "expect must be an object");
  value = enforceRequiredActionExpectation(surface, action, target, value);
  const output = surface === "browser" ? normalizeBrowserExpectation(value, target) : normalizeApplicationExpectation(value, target);
  if (!Object.keys(output).length) throw new BridgeError("invalid_request", "expect must contain at least one condition");
  return output;
}

function defaultExpectation(surface, action, target) {
  if (surface === "browser" && action === "check") return { target_state: "checked" };
  if (surface === "browser" && action === "uncheck") return { target_state: "unchecked" };
  if (surface === "application" && action === "activate") return { frontmost: true };
  if (surface === "application" && (action === "focus" || action === "keystroke") && target?.kind === "ref") return { target_focused: true };
  if (surface === "application" && action === "check" && target?.kind === "ref") return { target_checked: true };
  if (surface === "application" && action === "uncheck" && target?.kind === "ref") return { target_checked: false };
  if (surface === "application" && action === "set_value" && target?.kind === "ref" && target.element?.sensitive !== true) return { target_value_matches: true };
  if (surface === "application" && action === "click") return applicationIntrinsicClickExpectation(target);
  return null;
}

function enforceRequiredActionExpectation(surface, action, target, value) {
  if (surface === "browser" && (action === "check" || action === "uncheck")) {
    const required = action === "check" ? "checked" : "unchecked";
    if (value.target_state !== undefined && (typeof value.target_state !== "string" || value.target_state !== required)) {
      throw new BridgeError("invalid_request", `browser ${action} requires expect.target_state=${required}`);
    }
    return { ...value, target_state: required };
  }
  if (surface === "application" && (action === "focus" || action === "keystroke") && target?.kind === "ref") {
    if (value.target_focused !== undefined && value.target_focused !== true) {
      throw new BridgeError("invalid_request", `application ${action} requires expect.target_focused=true`);
    }
    return { ...value, target_focused: true };
  }
  if (surface === "application" && (action === "check" || action === "uncheck") && target?.kind === "ref") {
    const required = action === "check";
    if (value.target_checked !== undefined && value.target_checked !== required) {
      throw new BridgeError("invalid_request", `application ${action} requires expect.target_checked=${required}`);
    }
    return { ...value, target_checked: required };
  }
  if (surface === "application" && value.target_value_matches !== undefined && action !== "set_value") {
    throw new BridgeError("invalid_request", "expect.target_value_matches is only valid for application set_value");
  }
  if (surface === "application" && action === "set_value" && target?.kind === "ref") {
    if (target.element?.sensitive === true) {
      if (value.target_value_matches !== undefined) {
        throw new BridgeError("invalid_request", "expect.target_value_matches is unavailable for sensitive application targets");
      }
      return value;
    }
    if (value.target_value_matches !== undefined && value.target_value_matches !== true) {
      throw new BridgeError("invalid_request", "application set_value requires expect.target_value_matches=true");
    }
    return { ...value, target_value_matches: true };
  }
  return value;
}

function normalizeBrowserExpectation(value, target) {
  assertExpectationKeys(value, new Set(["url_contains", "url_changed", "text", "load_state", "target_state", "semantic_change", "visual_change"]), "browser");
  const output = {};
  if (value.url_contains !== undefined) output.url_contains = requiredString(value.url_contains, "expect.url_contains", 32768);
  if (value.url_changed !== undefined) output.url_changed = requiredBoolean(value.url_changed, "expect.url_changed");
  if (value.semantic_change !== undefined) output.semantic_change = requiredBoolean(value.semantic_change, "expect.semantic_change");
  if (value.visual_change !== undefined) output.visual_change = requiredBoolean(value.visual_change, "expect.visual_change");
  if (value.text !== undefined) output.text = requiredString(value.text, "expect.text", 4000);
  if (value.load_state !== undefined) {
    if (typeof value.load_state !== "string" || !BROWSER_LOAD_STATES.has(value.load_state)) {
      throw new BridgeError("invalid_request", "expect.load_state must be domcontentloaded or complete");
    }
    output.load_state = value.load_state;
  }
  if (value.target_state !== undefined) {
    if (typeof value.target_state !== "string" || !BROWSER_STATES.has(value.target_state)) {
      throw new BridgeError("invalid_request", "expect.target_state is not supported");
    }
    if (!target || target.kind !== "ref") throw new BridgeError("invalid_request", "expect.target_state requires a semantic ref target");
    output.target_state = value.target_state;
  }
  return output;
}

function normalizeApplicationExpectation(value, target) {
  assertExpectationKeys(value, new Set(["frontmost", "target_exists", "target_enabled", "target_focused", "target_checked", "target_selected", "target_expanded", "target_value_matches", "semantic_change", "visual_change"]), "application");
  const output = {};
  if (value.frontmost !== undefined) output.frontmost = requiredBoolean(value.frontmost, "expect.frontmost");
  if (value.semantic_change !== undefined) output.semantic_change = requiredBoolean(value.semantic_change, "expect.semantic_change");
  if (value.visual_change !== undefined) output.visual_change = requiredBoolean(value.visual_change, "expect.visual_change");
  if (value.target_exists !== undefined) output.target_exists = requiredBoolean(value.target_exists, "expect.target_exists");
  if (value.target_enabled !== undefined) output.target_enabled = requiredBoolean(value.target_enabled, "expect.target_enabled");
  if (value.target_focused !== undefined) output.target_focused = requiredBoolean(value.target_focused, "expect.target_focused");
  if (value.target_checked !== undefined) output.target_checked = requiredBoolean(value.target_checked, "expect.target_checked");
  if (value.target_selected !== undefined) output.target_selected = requiredBoolean(value.target_selected, "expect.target_selected");
  if (value.target_expanded !== undefined) output.target_expanded = requiredBoolean(value.target_expanded, "expect.target_expanded");
  if (value.target_value_matches !== undefined) output.target_value_matches = requiredBoolean(value.target_value_matches, "expect.target_value_matches");
  if (hasApplicationTargetExpectation(output) && !applicationVerificationTarget(target)) {
    throw new BridgeError("invalid_request", "target expectations require a semantic application target");
  }
  return output;
}

function assertExpectationKeys(value, allowed, surface) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BridgeError("invalid_request", `expect.${key} is not valid for ${surface}`);
}

function hasApplicationTargetExpectation(value) {
  return ["target_exists", "target_enabled", "target_focused", "target_checked", "target_selected", "target_expanded", "target_value_matches"]
    .some((key) => key in value);
}

function applicationVerificationTarget(target) {
  if (target?.kind === "ref") return target;
  if (target?.kind === "point" && target.semantic_delivery) return target.semantic_delivery;
  return null;
}

function applicationElementRole(element) {
  return typeof element?.role === "string" ? element.role.trim().toLowerCase() : "";
}

function applicationIntrinsicClickExpectation(target) {
  const semantic = applicationVerificationTarget(target);
  const element = semantic?.element || null;
  const role = applicationElementRole(element);
  if (role === "axcheckbox" && typeof element?.checked === "boolean") {
    return { target_checked: !element.checked };
  }
  if (role === "axradiobutton" && typeof element?.checked === "boolean") {
    return { target_checked: true };
  }
  if (role === "axdisclosuretriangle" && typeof element?.expanded === "boolean") {
    return { target_expanded: !element.expanded };
  }
  return null;
}

function validateApplicationStateActionTarget(action, element) {
  if (action !== "check" && action !== "uncheck") return;
  const role = applicationElementRole(element);
  if (action === "check" && !["axcheckbox", "axradiobutton"].includes(role)) {
    throw new BridgeError("invalid_request", "application check requires an Accessibility checkbox or radio button target");
  }
  if (action === "uncheck" && role !== "axcheckbox") {
    throw new BridgeError("invalid_request", "application uncheck requires an Accessibility checkbox target");
  }
  if (typeof element?.checked !== "boolean") {
    throw new BridgeError("conflict", "application checked state is unavailable in this snapshot; observe again before using check or uncheck", {
      details: { reason: "application_checked_state_unavailable" },
    });
  }
}

function applicationStateActionTargetSupported(action, element) {
  if (action !== "check" && action !== "uncheck") return true;
  const role = applicationElementRole(element);
  const roleSupported = action === "check" ? ["axcheckbox", "axradiobutton"].includes(role) : role === "axcheckbox";
  return roleSupported && typeof element?.checked === "boolean";
}

function combineBrowserPostChecks(probe, diff, expectation, before, after, target) {
  let matched = probe.post_check_pending === true ? probe.wait_matched === true : probe.matched === true;
  const checks = [];
  if (expectation.url_changed !== undefined) {
    const ok = diff?.url_changed === expectation.url_changed;
    matched = matched && ok;
    checks.push({ condition: "url_changed", matched: ok, evidence_source: "browser_tab_state" });
  }
  if (expectation.semantic_change !== undefined) {
    const ok = diff?.semantic_changed === expectation.semantic_change;
    matched = matched && ok;
    checks.push({ condition: "semantic_change", matched: ok, evidence_source: "browser_semantic" });
  }
  if (expectation.visual_change !== undefined) {
    const observed = diff?.screenshot_changed;
    const ok = typeof observed === "boolean" && observed === expectation.visual_change;
    matched = matched && ok;
    checks.push({ condition: "visual_change", matched: ok, observed: typeof observed === "boolean" ? observed : null, evidence_source: "screenshot" });
  }
  if (expectation.target_state) {
    for (const check of browserPostTargetStateChecks(before, after, target, expectation.target_state)) {
      if (check.inconclusive === true) matched = false;
      else matched = matched && check.matched === true;
      checks.push({ evidence_source: "browser_semantic", ...check });
    }
  }
  const definitiveFailure = probe.wait_matched === false || checks.some((check) => check.matched === false && check.inconclusive !== true);
  const inconclusive = !definitiveFailure && checks.some((check) => check.inconclusive === true);
  return {
    ...probe,
    matched: matched && !inconclusive,
    inconclusive,
    post_check_pending: false,
    reason: matched && !inconclusive
      ? "post_conditions_satisfied"
      : inconclusive
        ? "post_conditions_inconclusive"
        : probe.wait_matched === false ? probe.reason : "post_conditions_not_observed",
    post_checks: checks,
  };
}

function browserExpectationNeedsPostObservation(expectation) {
  return expectation?.url_changed !== undefined
    || expectation?.semantic_change !== undefined
    || expectation?.visual_change !== undefined
    || Boolean(expectation?.target_state);
}

function browserPostTargetStateChecks(before, after, target, state) {
  if (!target || target.kind !== "ref") return [{ condition: "target_state", matched: false, reason: "target_state_requires_ref_target" }];
  const frameEpochStatus = browserTargetFrameEpochStatus(before, after, target);
  if (frameEpochStatus === "unknown") return [{
    condition: "target_state",
    matched: false,
    observed: null,
    inconclusive: true,
    reason: "post_target_frame_coverage_incomplete",
  }];
  if (frameEpochStatus === "changed") {
    const goneMatches = state === "detached" || state === "hidden";
    return [{
      condition: "target_state",
      matched: goneMatches,
      observed: goneMatches ? state : null,
      reason: "target_frame_epoch_changed",
    }];
  }
  const frame = (after.semantic?.frames || []).find((candidate) => candidate?.frame_id === target.frame_id) || null;
  const complete = after.semantic?.frames_truncated === false && Boolean(frame) && frame.truncated === false;
  const element = (frame?.elements || []).find((candidate) => candidate?.ref === target.ref) || null;
  if (!element) {
    if (!complete) return [{
      condition: "target_state",
      matched: false,
      observed: null,
      inconclusive: true,
      reason: "post_target_coverage_incomplete",
    }];
    const absentMatches = state === "detached" || state === "hidden";
    return [{ condition: "target_state", matched: absentMatches, observed: absentMatches ? state : "detached" }];
  }
  const identityMatched = browserSnapshotIdentityMatches(browserSnapshotIdentity(target.element), element);
  const checks = [{ condition: "target_identity", matched: identityMatched }];
  if (!identityMatched) {
    checks.push({ condition: "target_state", matched: false, observed: null, reason: "target_semantic_identity_changed" });
    return checks;
  }
  const observed = browserObservedTargetState(element, state);
  if (observed === null) {
    checks.push({ condition: "target_state", matched: false, observed: null, inconclusive: true, reason: "target_state_unavailable" });
    return checks;
  }
  checks.push({ condition: "target_state", matched: observed, observed });
  return checks;
}

function browserTargetFrameEpochStatus(before, after, target) {
  if (!Number.isInteger(target?.frame_id)) return "unknown";
  const beforeFrame = (before.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id) || null;
  const afterFrame = (after.semantic?.frames || []).find((frame) => frame?.frame_id === target.frame_id) || null;
  if (!beforeFrame) return "unknown";
  if (!afterFrame) return after.semantic?.frames_truncated === true ? "unknown" : "changed";
  const beforeEpoch = typeof beforeFrame.document?.epoch === "string" ? beforeFrame.document.epoch : "";
  const afterEpoch = typeof afterFrame.document?.epoch === "string" ? afterFrame.document.epoch : "";
  const beforeUrl = typeof beforeFrame.document?.url === "string" ? beforeFrame.document.url : "";
  const afterUrl = typeof afterFrame.document?.url === "string" ? afterFrame.document.url : "";
  if (!beforeEpoch || !afterEpoch || !beforeUrl || !afterUrl) return "unknown";
  return beforeEpoch === afterEpoch && beforeUrl === afterUrl ? "same" : "changed";
}

function browserObservedTargetState(element, state) {
  if (state === "attached") return true;
  if (state === "detached") return false;
  if (state === "visible") return typeof element?.visible === "boolean" ? element.visible : null;
  if (state === "hidden") return typeof element?.visible === "boolean" ? !element.visible : null;
  if (state === "enabled") return typeof element?.enabled === "boolean" ? element.enabled : null;
  if (state === "editable") return typeof element?.editable === "boolean" ? element.editable : null;
  if (state === "checked") return typeof element?.checked === "boolean" ? element.checked : null;
  if (state === "unchecked") return typeof element?.checked === "boolean" ? !element.checked : null;
  return null;
}

function applicationPostTargetCheck(condition, match, expected, field, coverageComplete) {
  if (!match && !coverageComplete) return {
    condition, matched: false, observed: null, inconclusive: true, reason: "post_target_coverage_incomplete",
  };
  const observed = field ? match?.[field] : Boolean(match);
  return { condition, matched: field ? Boolean(match) && observed === expected : observed === expected };
}

function applicationVerificationEvidenceSource(condition) {
  if (condition === "process_identity") return "application_process";
  if (condition === "frontmost") return "application_workspace";
  if (condition === "visual_change") return "screenshot";
  return "application_accessibility";
}

function verifyApplicationExpectation(before, after, target, expectation, diff, beforePrivateState, postPrivateState, valueProbe = null) {
  const checks = [];
  if (applicationProcessChanged(beforePrivateState, postPrivateState) === true) {
    checks.push({ condition: "process_identity", matched: false });
  }
  if (expectation.frontmost !== undefined) checks.push({
    condition: "frontmost",
    matched: after.target.frontmost === expectation.frontmost,
  });
  if (expectation.semantic_change !== undefined) checks.push({
    condition: "semantic_change",
    matched: diff?.semantic_changed === expectation.semantic_change,
  });
  if (expectation.visual_change !== undefined) {
    const observed = diff?.screenshot_changed;
    checks.push({ condition: "visual_change", matched: typeof observed === "boolean" && observed === expectation.visual_change, observed: typeof observed === "boolean" ? observed : null });
  }
  const verificationTarget = applicationVerificationTarget(target);
  if (verificationTarget) {
    const match = findPostApplicationTarget(after, postPrivateState, verificationTarget);
    const targetCoverageComplete = after.semantic?.truncated === false;
    if (expectation.target_exists !== undefined) checks.push(applicationPostTargetCheck(
      "target_exists", match, expectation.target_exists, null, targetCoverageComplete));
    if (expectation.target_enabled !== undefined) checks.push(applicationPostTargetCheck(
      "target_enabled", match, expectation.target_enabled, "enabled", targetCoverageComplete));
    if (expectation.target_focused !== undefined) checks.push(applicationPostTargetCheck(
      "target_focused", match, expectation.target_focused, "focused", targetCoverageComplete));
    if (expectation.target_checked !== undefined) checks.push(applicationPostTargetCheck(
      "target_checked", match, expectation.target_checked, "checked", targetCoverageComplete));
    if (expectation.target_selected !== undefined) checks.push(applicationPostTargetCheck(
      "target_selected", match, expectation.target_selected, "selected", targetCoverageComplete));
    if (expectation.target_expanded !== undefined) checks.push(applicationPostTargetCheck(
      "target_expanded", match, expectation.target_expanded, "expanded", targetCoverageComplete));
    if (expectation.target_value_matches !== undefined) {
      const available = valueProbe?.available === true;
      checks.push({
        condition: "target_value_matches",
        matched: available && valueProbe.matched === expectation.target_value_matches,
        observed: available ? valueProbe.matched === true : null,
        ...(available ? {} : { inconclusive: true, reason: String(valueProbe?.reason || "value_readback_unavailable") }),
      });
    }
  }
  const postChecks = checks.map((check) => ({ evidence_source: applicationVerificationEvidenceSource(check.condition), ...check }));
  const definitiveFailure = postChecks.some((check) => check.matched === false && check.inconclusive !== true);
  const inconclusive = !definitiveFailure && postChecks.some((check) => check.inconclusive === true);
  return {
    requested: true,
    matched: postChecks.length > 0 && postChecks.every((check) => check.matched),
    inconclusive,
    reason: postChecks.every((check) => check.matched)
      ? "post_conditions_satisfied"
      : inconclusive
        ? "post_conditions_inconclusive"
        : "post_conditions_not_observed",
    post_checks: postChecks,
  };
}

function classifyEffectStatus({ dispatchStatus, expectation, verificationProbe, postCapture }) {
  if (!expectation) return "unknown";
  if (verificationProbe.matched === true) return "confirmed";
  if (verificationProbe.inconclusive === true) return "unknown";
  if (dispatchStatus === "unknown" || !postCapture) return "unknown";
  return "not_observed";
}

function browserPostFocusQuery(target) {
  if (!target || target.kind !== "ref") return undefined;
  const element = target.element || {};
  const value = element.name || element.label || element.placeholder || element.text || element.id || "";
  return String(value).trim().slice(0, 1000) || undefined;
}

function validateApplicationInspectionEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("application observation is invalid");
  applicationObservationString(value.process_name, 1000, false);
  if (!Array.isArray(value.elements) || value.elements.length > MAX_APPLICATION_OBSERVATION_ELEMENTS) {
    throw new Error("application observation elements are invalid");
  }
  for (const element of value.elements) {
    if (!element || typeof element !== "object" || Array.isArray(element)) throw new Error("application observation element is invalid");
  }
  for (const field of ["frontmost", "truncated", "menus_included"]) {
    if (typeof value[field] !== "boolean") throw new Error(`application observation ${field} is invalid`);
  }
}

function applicationObservationString(value, maxLength, allowEmpty) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error("application observation string is invalid");
  }
  return value;
}

function validateBrowserObservationForSnapshot(captured) {
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) throw new Error("browser observation is invalid");
  if (!Number.isSafeInteger(captured.tab_id) || captured.tab_id < 1) throw new Error("browser observation tab id is invalid");
  browserObservationAuthorityString(captured.url, 32768, false);
  browserObservationString(captured.title, 32768, true);
  if (captured.document_epoch !== undefined) browserObservationAuthorityString(captured.document_epoch, 9000, true);
  if (captured.capture !== undefined) {
    if (!captured.capture || typeof captured.capture !== "object" || Array.isArray(captured.capture)) throw new Error("browser observation capture is invalid");
    if (captured.capture.semantic_epoch !== undefined) browserObservationAuthorityString(captured.capture.semantic_epoch, 9000, true);
    if (captured.capture.cdp_epoch !== undefined) browserObservationAuthorityString(captured.capture.cdp_epoch, 9000, true);
  }
  if (captured.semantic === undefined) return;
  if (!captured.semantic || typeof captured.semantic !== "object" || Array.isArray(captured.semantic)) {
    throw new Error("browser observation semantic payload is invalid");
  }
  if (captured.semantic.tab_id !== undefined) {
    if (!Number.isSafeInteger(captured.semantic.tab_id) || captured.semantic.tab_id < 1) throw new Error("browser observation tab id is invalid");
  }
  if (captured.semantic.url !== undefined) browserObservationAuthorityString(captured.semantic.url, 32768, false);
  if (captured.semantic.title !== undefined) browserObservationString(captured.semantic.title, 32768, true);
  if (typeof captured.semantic.frames_truncated !== "boolean") {
    throw new Error("browser observation truncation evidence is invalid");
  }
  if (captured.semantic.frames === undefined) return;
  if (!Array.isArray(captured.semantic.frames)) throw new Error("browser observation semantic frames are invalid");
  for (const frame of captured.semantic.frames) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || !Number.isSafeInteger(frame.frame_id) || frame.frame_id < 0) {
      throw new Error("browser observation frame authority is invalid");
    }
    if (typeof frame.truncated !== "boolean") {
      throw new Error("browser observation truncation evidence is invalid");
    }
    if (frame.document === undefined) continue;
    if (!frame.document || typeof frame.document !== "object" || Array.isArray(frame.document)) {
      throw new Error("browser observation frame authority is invalid");
    }
    if (frame.document.epoch !== undefined) browserObservationAuthorityString(frame.document.epoch, 9000, true);
    if (frame.document.url !== undefined) browserObservationAuthorityString(frame.document.url, 32768, false);
  }
}

function browserObservationAuthorityString(value, maxLength, allowEmpty) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error("browser observation authority string is invalid");
  }
  return value;
}

function browserObservationString(value, maxLength, allowEmpty) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new Error("browser observation string is invalid");
  }
  return value;
}

function browserObservationArgs(args) {
  return {
    tab_id: optionalPositiveInt(args.tab_id, "tab_id"),
    max_elements: clampInt(args.max_elements, 300, 1, 1000),
    max_ax_nodes: clampInt(args.max_ax_nodes, 600, 1, 2000),
    max_frames: clampInt(args.max_frames, 32, 1, 64),
    ax_depth: clampInt(args.ax_depth, 12, 1, 16),
    include_values: optionalBoolean(args.include_values, "include_values", false),
    all_frames: optionalBoolean(args.all_frames, "all_frames", true),
    include_screenshot: optionalBoolean(args.include_screenshot, "include_screenshot", true),
    screenshot_format: computerScreenshotFormat(args.screenshot_format),
    screenshot_quality: clampInt(args.screenshot_quality, 90, 1, 100),
    timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    focus_query: args.focus_query === undefined ? undefined : requiredStringAllowEmpty(args.focus_query, "focus_query", 1000),
  };
}

function findApplicationMatch(elements, selector, occurrence) {
  const matches = elements.filter((element) => applicationMatchesSelector(element, selector));
  return matches[occurrence] || null;
}

function findPostApplicationTarget(observation, privateState, target) {
  const record = findPostApplicationTargetBinding(observation, privateState, target);
  if (record) return record.element;
  if (privateState?.application_ref_bindings?.entries) return null;
  return findApplicationMatch(observation.semantic?.elements || [], target.selector, target.occurrence);
}

function findPostApplicationTargetBinding(observation, privateState, target) {
  const bindings = privateState?.application_ref_bindings;
  if (bindings?.entries) {
    const expectedSelector = JSON.stringify(target.selector || {});
    for (const [ref, binding] of bindings.entries()) {
      if (binding?.occurrence !== target.occurrence || JSON.stringify(binding?.selector || {}) !== expectedSelector) continue;
      if (!applicationPostOwnerWindowContinues(target?.owner_window_bounds, binding?.owner_window_bounds)) return null;
      const element = (observation.semantic?.elements || []).find((candidate) => candidate?.ref === ref) || null;
      if (element) return { ref, element, binding };
    }
  }
  return null;
}

function applicationPostOwnerWindowContinues(beforeBounds, afterBounds) {
  const before = normalizedWindowBounds(beforeBounds);
  const after = normalizedWindowBounds(afterBounds);
  if (!before && !after) return true;
  if (!before || !after) return false;
  return ["x", "y", "width", "height"].every((key) => Math.abs(before[key] - after[key]) <= 1);
}

function sanitizeDispatchResult(surface, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value.point ? sanitizeDispatchPoint(value.point) : null;
  const destinationPoint = value.destination_point ? sanitizeDispatchPoint(value.destination_point) : null;
  const scrollDelta = sanitizeDispatchScrollDelta(value.scroll_delta);
  if (surface === "browser") {
    return {
      ok: value.ok === true,
      input_mode: typeof value.input_mode === "string" ? value.input_mode : "",
      trusted_input_fallback: value.trusted_input_fallback === true,
      coordinate_source: typeof value.coordinate_source === "string" ? value.coordinate_source : "",
      cross_frame_trusted: value.cross_frame_trusted === true,
      no_input_required: value.no_input_required === true,
      tab_id: Number.isSafeInteger(value.tab_id) && value.tab_id > 0 ? value.tab_id : null,
      url: typeof value.url === "string" ? value.url : "",
      title: typeof value.title === "string" ? value.title : "",
      tab_metadata_verified: typeof value.tab_metadata_verified === "boolean" ? value.tab_metadata_verified : null,
      ...(point ? { point } : {}),
      ...(destinationPoint ? { destination_point: destinationPoint } : {}),
      ...(scrollDelta ? { scroll_delta: scrollDelta } : {}),
      ...(value.hit ? { hit: sanitizeVisualHit(value.hit) } : {}),
      ...(value.destination_hit ? { destination_hit: sanitizeVisualHit(value.destination_hit) } : {}),
    };
  }
  const normalizedPoint = sanitizeNormalizedResultPoint(value.normalized_point);
  const destinationNormalizedPoint = sanitizeNormalizedResultPoint(value.destination_normalized_point);
  return {
    ok: value.ok === true,
    matched: Number.isSafeInteger(value.matched) && value.matched >= 0 ? value.matched : 0,
    selected_index: Number.isSafeInteger(value.selected_index) && value.selected_index >= 0 ? value.selected_index : null,
    no_input_required: value.no_input_required === true,
    checked_before: typeof value.checked_before === "boolean" ? value.checked_before : null,
    checked_after: typeof value.checked_after === "boolean" ? value.checked_after : null,
    coordinate_source: typeof value.coordinate_source === "string" ? value.coordinate_source : "",
    input_transport: typeof value.input_transport === "string" ? value.input_transport : "",
    focus_prepared: value.focus_prepared === true,
    window_bound: value.window_bound === true,
    screenshot_revalidated: value.screenshot_revalidated === true,
    experimental_backend: value.experimental_backend === true,
    focus_without_raise: value.focus_without_raise === true,
    front_window_validated: value.front_window_validated === true,
    cursor_preserved: typeof value.cursor_preserved === "boolean" ? value.cursor_preserved : null,
    frontmost_restored: value.frontmost_restored === true,
    ...(normalizedPoint ? { normalized_point: normalizedPoint } : {}),
    ...(destinationNormalizedPoint ? { destination_normalized_point: destinationNormalizedPoint } : {}),
    ...(scrollDelta ? { scroll_delta: scrollDelta } : {}),
    ...(Array.isArray(value.semantic_point_candidates) ? { semantic_point_candidates: value.semantic_point_candidates.slice(0, 4).map(sanitizeApplicationPointCandidate) } : {}),
  };
}

function sanitizeDispatchScrollDelta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deltaX = value.delta_x;
  const deltaY = value.delta_y;
  if (typeof deltaX !== "number" || !Number.isFinite(deltaX) || typeof deltaY !== "number" || !Number.isFinite(deltaY)) return null;
  return { delta_x: Object.is(deltaX, -0) ? 0 : deltaX, delta_y: Object.is(deltaY, -0) ? 0 : deltaY };
}

function sanitizeNormalizedResultPoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x >= 1
      || typeof y !== "number" || !Number.isFinite(y) || y < 0 || y >= 1) return null;
  return { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y };
}

async function trySnapshotBoundBackendAction({ browser, observation, action, target, args, context, inputMode, navigationWait }) {
  const backendTextEligible = !BROWSER_BACKEND_TEXT_ACTIONS.has(action) || target?.element?.editable !== false;
  if (target?.kind !== "ref" || !target.trusted_binding || !BROWSER_BACKEND_TRUSTED_ACTIONS.has(action) || !backendTextEligible || inputMode === "dom") return null;
  try {
    const result = await browser.backendNodeAction({
      tab_id: observation.target.tab_id,
      action,
      backend_node_id: target.trusted_binding.backend_node_id,
      extension_frame_id: target.trusted_binding.extension_frame_id,
      frame_document_epoch: target.trusted_binding.extension_frame_epoch,
      frame_url: target.trusted_binding.extension_frame_url,
      extension_ref: target.ref,
      expected_ref_identity: browserSnapshotIdentity(target.element),
      document_epoch: browserObservationSemanticEpoch(observation),
      value: args.value,
      value_resource: args.value_resource,
      key: args.key,
      timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
    }, context);
    if (navigationWait !== "none") {
      try {
        await browser.wait({
          tab_id: observation.target.tab_id,
          load_state: navigationWait,
          timeout_seconds: clampInt(args.timeout_seconds, 30, 1, 60),
        }, context);
      } catch (error) {
        throw browserPostDispatchWaitUnknown(error);
      }
    }
    return result;
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("snapshot backend target changed before trusted input; observe again")
        || message.includes("snapshot_backend_target_changed_before_dispatch")) {
      throw staleSnapshot("browser semantic target changed before trusted input");
    }
    if (message.includes("outcome is unknown")) throw error;
    if (message.includes("trusted browser input may have been partially dispatched")) throw error;
    if (inputMode === "trusted") throw backendTrustedUnavailable();
    return null;
  }
}

function browserSnapshotDispatchError(error) {
  const message = String(error?.message || error);
  if (message.includes("snapshot ref identity changed before dispatch; observe again")
      || message.includes("snapshot_ref_identity_changed_before_dispatch")) {
    return staleSnapshot("browser semantic target identity changed before input");
  }
  if (message.includes("snapshot browser tab changed before navigation dispatch; observe again")) {
    return staleSnapshot("browser tab URL changed immediately before the navigation action");
  }
  if (message.includes("snapshot browser tab could not be verified before navigation dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser tab immediately before this navigation action; observe again", {
      details: { reason: "browser_navigation_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot history document changed before dispatch; observe again")) {
    return staleSnapshot("browser document changed immediately before the history action");
  }
  if (message.includes("snapshot history document could not be verified before dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser document immediately before this history action; observe again", {
      details: { reason: "browser_document_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot history entry changed before dispatch; observe again")) {
    return staleSnapshot("browser history entry changed immediately before the history action");
  }
  if (message.includes("snapshot history entry could not be verified before dispatch; observe again")) {
    return new BridgeError("unavailable", "cannot validate the browser history entry immediately before this history action; observe again", {
      details: { reason: "browser_history_last_hop_unavailable" },
    });
  }
  if (message.includes("snapshot browser history has no back entry before dispatch; observe again")
      || message.includes("snapshot browser history has no forward entry before dispatch; observe again")) {
    return new BridgeError("unavailable", "the requested browser history direction is unavailable in this snapshot; observe again", {
      details: { reason: "browser_history_direction_unavailable" },
    });
  }
  if (message.includes("snapshot history mutation API is unavailable before dispatch; observe again")) {
    return new BridgeError("unavailable", "the snapshot-bound browser history mutation API is unavailable; observe again", {
      details: { reason: "browser_history_mutation_api_unavailable" },
    });
  }
  return error instanceof Error ? error : new Error(message);
}

function backendTrustedUnavailable() {
  return new BridgeError("unavailable", "snapshot-bound trusted input is unavailable for this semantic target", {
    details: { reason: "snapshot_backend_trusted_input_unavailable" },
  });
}

function browserPostDispatchWaitUnknown(error) {
  const detail = String(error?.message || error || "").replace(/\s+/g, " ").slice(0, 500);
  return new Error(`browser action may have been dispatched; the action outcome is unknown because post-dispatch wait failed. Inspect the page before retrying.${detail ? ` (${detail})` : ""}`);
}

function sanitizeDispatchPoint(point) {
  if (!point || typeof point !== "object" || Array.isArray(point)) return null;
  if (typeof point.normalized_x === "number" && Number.isFinite(point.normalized_x) && point.normalized_x >= 0 && point.normalized_x < 1
      && typeof point.normalized_y === "number" && Number.isFinite(point.normalized_y) && point.normalized_y >= 0 && point.normalized_y < 1
      && typeof point.css_x === "number" && Number.isFinite(point.css_x)
      && typeof point.css_y === "number" && Number.isFinite(point.css_y)) {
    return { normalized_x: point.normalized_x, normalized_y: point.normalized_y, css_x: point.css_x, css_y: point.css_y };
  }
  if (typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)) {
    return { css_x: point.x, css_y: point.y };
  }
  return null;
}

const UNKNOWN_MUTATION_ERROR_PREFIXES = Object.freeze([
  "browser mutation request may have been dispatched;",
  "browser mutation may have completed;",
  "browser action may have been dispatched;",
  "trusted browser input may have been partially dispatched;",
  "browser tab mutation may have been dispatched;",
  "browser screenshot temporary tab activation may have been dispatched;",
  "browser screenshot restoration may have been dispatched;",
  "application visual input may have been partially dispatched;",
  "application launch may have been partially dispatched;",
  "application accessibility mutation may have been partially dispatched;",
  "application activation may have been partially dispatched;",
  "application checked-state input may have been partially dispatched;",
  "application accessibility input may have been partially dispatched;",
  "application value input may have been partially dispatched;",
  "application keystroke may have been partially dispatched;",
  "application key_press may have been partially dispatched;",
]);

function isUnknownOutcomeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return UNKNOWN_MUTATION_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function staleSnapshot(detail) {
  return new BridgeError("conflict", `computer snapshot is stale: ${detail}; observe again before acting`, {
    details: { reason: "stale_snapshot" },
  });
}

function requiredSurface(value) {
  if (typeof value !== "string" || !["browser", "application"].includes(value)) throw new BridgeError("invalid_request", "surface must be browser or application");
  return value;
}

function requiredSnapshotId(value) {
  if (typeof value !== "string" || !/^cu_[A-Za-z0-9_-]{8,80}$/.test(value)) throw new BridgeError("invalid_request", "snapshot_id is invalid");
  return value;
}

function optionalPrivateApplicationProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredPrivateApplicationProcessId(value) {
  const processId = optionalPrivateApplicationProcessId(value);
  if (!processId) {
    throw new BridgeError("unavailable", "application process identity is unavailable for snapshot-bound Computer Use", {
      details: { reason: "application_process_identity_unavailable" },
    });
  }
  return processId;
}

function optionalPrivateApplicationProcessGeneration(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value)) return null;
  return value;
}

function requiredPrivateApplicationProcessGeneration(value) {
  const generation = optionalPrivateApplicationProcessGeneration(value);
  if (!generation) {
    throw new BridgeError("unavailable", "application process generation is unavailable for snapshot-bound Computer Use", {
      details: { reason: "application_process_identity_unavailable" },
    });
  }
  return generation;
}

function applicationProcessChanged(beforePrivateState, afterPrivateState) {
  const beforeId = optionalPrivateApplicationProcessId(beforePrivateState?.application_process_id);
  const afterId = optionalPrivateApplicationProcessId(afterPrivateState?.application_process_id);
  const beforeGeneration = optionalPrivateApplicationProcessGeneration(beforePrivateState?.application_process_generation);
  const afterGeneration = optionalPrivateApplicationProcessGeneration(afterPrivateState?.application_process_generation);
  if (!beforeId || !afterId || !beforeGeneration || !afterGeneration) return null;
  return beforeId !== afterId || beforeGeneration !== afterGeneration;
}

function applicationProcessIdentityError(error) {
  const message = String(error?.message || error);
  return message.includes("application process changed before operation")
    || message.includes("application process generation changed before operation");
}

function applicationProcessIdentityMatches(value, expectedProcessId, expectedProcessGeneration) {
  return requiredPrivateApplicationProcessId(value?._machine_process_id) === expectedProcessId
    && requiredPrivateApplicationProcessGeneration(value?._machine_process_generation) === expectedProcessGeneration;
}

function isVisualPointTarget(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "point"));
}

function browserPointTarget(observation, action, value) {
  if (!BROWSER_POINT_ACTIONS.has(action)) throw new BridgeError("invalid_request", `visual point target is not valid for browser ${action}`);
  const keys = Object.keys(value || {});
  if (keys.length !== 1 || keys[0] !== "point") throw new BridgeError("invalid_request", "visual target accepts only point");
  const point = value.point;
  if (!point || typeof point !== "object" || Array.isArray(point)) throw new BridgeError("invalid_request", "target.point must be an object");
  const pointKeys = Object.keys(point);
  if (pointKeys.some((key) => !["x", "y", "space"].includes(key)) || !pointKeys.includes("x") || !pointKeys.includes("y")) {
    throw new BridgeError("invalid_request", "target.point requires only x, y, and optional space");
  }
  const space = point.space === undefined ? "normalized_viewport" : point.space;
  if (typeof space !== "string" || space !== "normalized_viewport") throw new BridgeError("invalid_request", "target.point.space must be normalized_viewport");
  const x = normalizedPointCoordinate(point.x, "target.point.x");
  const y = normalizedPointCoordinate(point.y, "target.point.y");
  if (observation.capture?.screenshot !== true || observation.capture?.screenshot_source !== "cdp_surface" || observation.capture?.navigation_coherent !== true) {
    throw new BridgeError("conflict", "visual point action requires a navigation-coherent CDP screenshot from this snapshot", {
      details: { reason: "visual_snapshot_not_actionable" },
    });
  }
  const screenshotDigest = observation.capture?.screenshot_sha256;
  const screenshotSha256 = typeof screenshotDigest === "string" ? screenshotDigest.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(screenshotSha256)) {
    throw new BridgeError("conflict", "visual point action requires the screenshot fingerprint from this snapshot", {
      details: { reason: "visual_snapshot_fingerprint_missing" },
    });
  }
  const viewport = observation.semantic?.viewport;
  if (!positiveNativeViewport(viewport)) {
    throw new BridgeError("conflict", "visual point action requires viewport metadata from the screenshot snapshot", {
      details: { reason: "visual_viewport_missing" },
    });
  }
  return {
    kind: "point",
    normalized_x: x,
    normalized_y: y,
    viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale },
    screenshot_sha256: screenshotSha256,
    screenshot_format: observation.capture?.screenshot_format === "jpeg" ? "jpeg" : "png",
    screenshot_quality: validPointScreenshotQuality(observation.capture?.screenshot_quality),
  };
}

function applicationPointTarget(observation, privateState, action, value) {
  if (!["click", "double_click", "drag", "scroll"].includes(action)) throw new BridgeError("invalid_request", `visual point target is not valid for application ${action}`);
  const keys = Object.keys(value || {});
  if (keys.length !== 1 || keys[0] !== "point") throw new BridgeError("invalid_request", "visual target accepts only point");
  const point = value.point;
  if (!point || typeof point !== "object" || Array.isArray(point)) throw new BridgeError("invalid_request", "target.point must be an object");
  const pointKeys = Object.keys(point);
  if (pointKeys.some((key) => !["x", "y", "space"].includes(key)) || !pointKeys.includes("x") || !pointKeys.includes("y")) {
    throw new BridgeError("invalid_request", "target.point requires only x, y, and optional space");
  }
  const space = point.space === undefined ? "normalized_viewport" : point.space;
  if (typeof space !== "string" || space !== "normalized_viewport") throw new BridgeError("invalid_request", "target.point.space must be normalized_viewport");
  const x = normalizedPointCoordinate(point.x, "target.point.x");
  const y = normalizedPointCoordinate(point.y, "target.point.y");
  const binding = privateState?.application_window_binding || null;
  if (observation.capture?.screenshot !== true || observation.capture?.screenshot_source !== "macos_window" || !binding) {
    throw new BridgeError("conflict", "application visual point action requires the exact macOS window screenshot from this snapshot", {
      details: { reason: "application_visual_snapshot_not_actionable" },
    });
  }
  const candidates = applicationPointCandidates(observation, binding, x, y);
  const semanticDelivery = action === "click" && observation.capabilities?.snapshot_bound_semantic_points === true
    ? applicationSemanticPointDelivery(observation, privateState, candidates)
    : null;
  if (!semanticDelivery && observation.capabilities?.snapshot_bound_visual_points !== true) {
    throw new BridgeError("conflict", "application point did not resolve uniquely to an actionable Accessibility element and no snapshot-bound pixel backend is available", {
      details: { reason: "application_visual_snapshot_not_actionable" },
    });
  }
  return {
    kind: "point",
    normalized_x: x,
    normalized_y: y,
    window_binding: binding,
    semantic_delivery: semanticDelivery,
    semantic_point_candidates: candidates,
  };
}

function applicationSemanticPointDelivery(observation, privateState, candidates) {
  const bindings = privateState?.application_ref_bindings;
  if (!bindings?.get) return null;
  const matches = [];
  for (const candidate of candidates) {
    const ref = typeof candidate?.ref === "string" ? candidate.ref : "";
    const element = (observation.semantic?.elements || []).find((item) => item?.ref === ref) || null;
    const binding = ref ? bindings.get(ref) || null : null;
    if (!element || !binding || !applicationElementSupportsPointClick(element)) continue;
    matches.push({
      ref,
      element,
      selector: binding.selector,
      occurrence: binding.occurrence,
      inspection: privateState?.application_inspection || null,
      owner_window_bounds: binding.owner_window_bounds || null,
      screen_box: binding.screen_box || null,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function applicationPointCandidates(observation, binding, normalizedX, normalizedY) {
  const windowBounds = normalizedWindowBounds(binding?.bounds);
  if (!windowBounds) return [];
  const x = normalizedX * windowBounds.width;
  const y = normalizedY * windowBounds.height;
  const candidates = [];
  for (const element of observation.semantic?.elements || []) {
    const box = normalizedWindowBounds(element?.bounding_box);
    if (!box || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue;
    candidates.push({
      ref: typeof element.ref === "string" ? element.ref : "",
      role: typeof element.role === "string" ? element.role : "",
      name: typeof element.name === "string" ? element.name.slice(0, 500)
        : typeof element.title === "string" ? element.title.slice(0, 500)
          : typeof element.description === "string" ? element.description.slice(0, 500) : "",
      sensitive: element.sensitive === true,
      bounding_box: box,
      area: box.width * box.height,
    });
  }
  candidates.sort((left, right) => left.area - right.area || left.ref.localeCompare(right.ref));
  return candidates.slice(0, 4).map(({ area: _area, ...candidate }) => candidate);
}

function currentApplicationSemanticPointCandidates(elements, target) {
  const windowBounds = normalizedWindowBounds(target?.window_binding?.bounds);
  const normalizedX = target?.normalized_x;
  const normalizedY = target?.normalized_y;
  if (!windowBounds || typeof normalizedX !== "number" || !Number.isFinite(normalizedX)
      || typeof normalizedY !== "number" || !Number.isFinite(normalizedY)) return [];
  const screenX = windowBounds.x + normalizedX * windowBounds.width;
  const screenY = windowBounds.y + normalizedY * windowBounds.height;
  const candidates = [];
  for (const element of elements || []) {
    if (!applicationElementSupportsPointClick(element)) continue;
    const ownerBounds = normalizedWindowBounds(element?.window_screen_box);
    if (!ownerBounds || !sameApplicationBounds(ownerBounds, windowBounds)) continue;
    const box = normalizedWindowBounds(element?.screen_box);
    if (!box || screenX < box.x || screenY < box.y || screenX > box.x + box.width || screenY > box.y + box.height) continue;
    candidates.push(element);
  }
  return candidates;
}

function applicationScreenshotBytes(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_APPLICATION_SCREENSHOT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 8 || bytes.length > MAX_APPLICATION_SCREENSHOT_BYTES || bytes.toString("base64") !== value) return null;
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a ? bytes : null;
}

function applicationWindowBinding(captured, screenshotSha256) {
  const screenshot = captured?.screenshot;
  const windowId = captured?.window?.id;
  const bounds = normalizedWindowBounds(captured?.window?.bounds || screenshot?.bounds);
  const digest = typeof screenshotSha256 === "string" ? screenshotSha256.toLowerCase() : "";
  if (screenshot?.source !== "macos_window" || screenshot?.mime_type !== "image/png" || typeof screenshot?.data !== "string"
      || !Number.isSafeInteger(windowId) || windowId < 1 || !bounds || !/^[a-f0-9]{64}$/.test(digest)) return null;
  return { window_id: windowId, bounds, screenshot_sha256: digest };
}

function sameApplicationWindowBinding(expected, current) {
  if (!expected || !current || expected.window_id !== current.window_id || expected.screenshot_sha256 !== current.screenshot_sha256) return false;
  return sameApplicationBounds(normalizedWindowBounds(expected.bounds), normalizedWindowBounds(current.bounds));
}

function sameApplicationWindowIdentity(expected, current) {
  const windowId = current?.window?.id ?? current?.id;
  const bounds = normalizedWindowBounds(current?.window?.bounds ?? current?.bounds);
  if (!expected || !Number.isSafeInteger(windowId) || windowId !== expected.window_id || !bounds) return false;
  return sameApplicationBounds(normalizedWindowBounds(expected.bounds), bounds);
}

function applicationCaptureCoherence({ screenshotRequested, hasImage, windowCoherent }) {
  if (!screenshotRequested) return "single_accessibility_inspection";
  if (!hasImage) return "accessibility_only_after_screenshot_failure";
  if (windowCoherent === true) return "window_screenshot_then_accessibility_window_stable";
  if (windowCoherent === false) return "window_changed_during_capture";
  return "window_screenshot_then_accessibility_unverified";
}

function applicationTargetInspection(target) {
  const inspection = target?.semantic_delivery?.inspection || target?.inspection || null;
  return {
    max_depth: clampInt(inspection?.max_depth, 6, 1, 12),
    include_menus: inspection?.include_menus === true,
  };
}

function applicationTargetGeometry(target) {
  const source = target?.semantic_delivery || target || {};
  return {
    owner_window_bounds: normalizedWindowBounds(source.owner_window_bounds),
    screen_box: normalizedWindowBounds(source.screen_box),
  };
}

function applicationTargetHasGeometry(target) {
  const geometry = applicationTargetGeometry(target);
  return Boolean(geometry.owner_window_bounds || geometry.screen_box);
}

function applicationTargetGeometryMatches(element, target) {
  const expected = applicationTargetGeometry(target);
  if (expected.owner_window_bounds && !sameApplicationBounds(expected.owner_window_bounds, normalizedWindowBounds(element?.window_screen_box))) return false;
  if (expected.screen_box && !sameApplicationBounds(expected.screen_box, normalizedWindowBounds(element?.screen_box))) return false;
  return true;
}

function applyApplicationTargetGeometry(call, target) {
  const geometry = applicationTargetGeometry(target);
  if (geometry.owner_window_bounds) call.expected_window_bounds = geometry.owner_window_bounds;
  if (geometry.screen_box) call.expected_element_bounds = geometry.screen_box;
  return call;
}

function sameApplicationBounds(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const a = left[key];
    const b = right[key];
    return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) <= 1;
  });
}

function normalizedWindowBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    bounds[key] = number;
  }
  return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

function normalizedPointCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new BridgeError("invalid_request", `${label} must be from 0 (inclusive) to 1 (exclusive)`);
  }
  return value;
}

function validPointScreenshotQuality(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 90;
}

function positiveNativeViewport(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0
    && typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0);
}

function sameVisualViewport(expected, current) {
  if (!positiveNativeViewport(expected) || !positiveNativeViewport(current)) return false;
  for (const key of ["width", "height", "scale"]) {
    if (Math.abs(expected[key] - current[key]) > 0.5) return false;
  }
  const offsetLeft = current.offset_left === undefined || current.offset_left === null ? 0 : current.offset_left;
  const offsetTop = current.offset_top === undefined || current.offset_top === null ? 0 : current.offset_top;
  if (typeof offsetLeft !== "number" || !Number.isFinite(offsetLeft) || typeof offsetTop !== "number" || !Number.isFinite(offsetTop)) return false;
  return Math.abs(current.scale - 1) <= 0.001 && Math.abs(offsetLeft) <= 0.5 && Math.abs(offsetTop) <= 0.5;
}

function sanitizeApplicationPointCandidate(value) {
  return {
    ref: typeof value?.ref === "string" ? value.ref : "",
    role: typeof value?.role === "string" ? value.role : "",
    name: typeof value?.name === "string" ? value.name.slice(0, 500) : "",
    sensitive: value?.sensitive === true,
    bounding_box: normalizedWindowBounds(value?.bounding_box),
  };
}

function sanitizeVisualHit(value) {
  return {
    ref: typeof value.ref === "string" ? value.ref : "",
    tag: typeof value.tag === "string" ? value.tag : "",
    role: typeof value.role === "string" ? value.role : "",
    name: typeof value.name === "string" ? value.name : "",
    sensitive: value.sensitive === true,
    bounding_box: normalizedWindowBounds(value.bounding_box),
  };
}

function requiredTargetRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid_request", "target must be an object containing a snapshot ref or supported snapshot-bound point");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "ref") throw new BridgeError("invalid_request", "semantic target accepts only ref");
  return requiredString(value.ref, "target.ref", 100);
}

function normalizeBrowserAction(value) {
  if (typeof value !== "string" || !BROWSER_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported browser computer action");
  return value;
}

function normalizeApplicationAction(value) {
  if (typeof value !== "string" || !APPLICATION_ACTIONS.has(value)) throw new BridgeError("invalid_request", "unsupported application computer action");
  return value;
}

function normalizeInputMode(value) {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !INPUT_MODES.has(value)) throw new BridgeError("invalid_request", "input_mode must be auto, trusted, or dom");
  return value;
}

function normalizePostScreenshotPolicy(args, surface) {
  if (!["browser", "application"].includes(surface)) return "never";
  if (args.post_screenshot !== undefined && args.include_post_screenshot !== undefined) {
    throw new BridgeError("invalid_request", "post_screenshot and include_post_screenshot are mutually exclusive");
  }
  if (args.include_post_screenshot !== undefined) {
    if (typeof args.include_post_screenshot !== "boolean") throw new BridgeError("invalid_request", "include_post_screenshot must be boolean");
    return args.include_post_screenshot ? "always" : "never";
  }
  if (args.post_screenshot === undefined) return "auto";
  if (typeof args.post_screenshot !== "string" || !["auto", "always", "never"].includes(args.post_screenshot)) {
    throw new BridgeError("invalid_request", "post_screenshot must be auto, always, or never");
  }
  return args.post_screenshot;
}

function shouldIncludePostScreenshot(policy, { surface, target, expectation, dispatchStatus }) {
  if (!["browser", "application"].includes(surface) || policy === "never") return false;
  if (policy === "always") return true;
  return target?.kind === "point" || expectation?.visual_change !== undefined || dispatchStatus === "unknown";
}

function normalizePostObservationDetail(value, surface) {
  if (value === undefined) return ["browser", "application"].includes(surface) ? "summary" : "full";
  if (typeof value !== "string" || !["summary", "full"].includes(value)) throw new BridgeError("invalid_request", "post_observation_detail must be summary or full");
  return value;
}

function normalizeNavigationWait(value) {
  if (value === undefined) return "none";
  if (typeof value !== "string" || !NAVIGATION_WAITS.has(value)) throw new BridgeError("invalid_request", "wait_for must be none, domcontentloaded, or complete");
  return value;
}

function validateObserveArgs(surface, args) {
  if (surface === "browser") {
    for (const key of ["application", "max_depth", "include_menus"]) {
      if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for application computer observations`);
    }
    return;
  }
  requiredString(args.application, "application", 300);
  for (const key of ["tab_id", "screenshot_format", "screenshot_quality", "all_frames", "max_ax_nodes", "max_frames", "ax_depth"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for browser computer observations`);
  }
}

function validateSurfaceActionArgs(surface, action, args) {
  if (args.value !== undefined && args.value_resource !== undefined) {
    throw new BridgeError("invalid_request", "value and value_resource are mutually exclusive");
  }
  if (surface === "browser") {
    validateBrowserActionArgs(action, args);
    return;
  }
  validateApplicationActionArgs(action, args);
}

function validateBrowserActionArgs(action, args) {
  for (const key of ["include_menus", "post_max_depth"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for application computer actions`);
  }
  if (action === "navigate") {
    if (args.url === undefined) throw new BridgeError("invalid_request", "browser navigate requires url");
  } else if (args.url !== undefined) {
    throw new BridgeError("invalid_request", "url is only valid for browser navigate");
  }
  if (action === "drag") {
    if (args.destination === undefined || args.destination === null) throw new BridgeError("invalid_request", "browser drag requires destination");
  } else if (args.destination !== undefined) {
    throw new BridgeError("invalid_request", "destination is only valid for browser drag");
  }
  if (action === "scroll") {
    const deltaX = browserScrollDelta(args.delta_x, "delta_x");
    const deltaY = browserScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "browser scroll requires a non-zero delta_x or delta_y");
  } else if (args.delta_x !== undefined || args.delta_y !== undefined) {
    throw new BridgeError("invalid_request", "delta_x and delta_y are only valid for browser scroll");
  }
  if (args.key !== undefined && action !== "press") throw new BridgeError("invalid_request", "key is only valid for browser press");
  if ((args.value !== undefined || args.value_resource !== undefined) && !["fill", "select", "press", "type_text"].includes(action)) {
    throw new BridgeError("invalid_request", `value is not valid for browser ${action}`);
  }
}

function validateApplicationActionArgs(action, args) {
  if (action === "drag") {
    if (args.destination === undefined || args.destination === null) throw new BridgeError("invalid_request", "application drag requires destination");
  } else if (args.destination !== undefined) {
    throw new BridgeError("invalid_request", "destination is only valid for drag");
  }
  if (action === "scroll") {
    const deltaX = browserScrollDelta(args.delta_x, "delta_x");
    const deltaY = browserScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new BridgeError("invalid_request", "application scroll requires a non-zero delta_x or delta_y");
  } else if (args.delta_x !== undefined || args.delta_y !== undefined) {
    throw new BridgeError("invalid_request", "delta_x and delta_y are only valid for scroll");
  }
  for (const key of ["url", "wait_for", "input_mode", "element_timeout_seconds", "post_max_ax_nodes"]) {
    if (args[key] !== undefined) throw new BridgeError("invalid_request", `${key} is only valid for browser computer actions`);
  }
  if (action === "key_press" && args.key === undefined) throw new BridgeError("invalid_request", "application key_press requires key");
  if (action !== "key_press" && args.key !== undefined) throw new BridgeError("invalid_request", `key is not valid for application ${action}`);
  const carriesValue = args.value !== undefined || args.value_resource !== undefined;
  if (carriesValue && !["set_value", "keystroke"].includes(action)) {
    throw new BridgeError("invalid_request", `value is not valid for application ${action}`);
  }
  if (["set_value", "keystroke"].includes(action) && !carriesValue) {
    throw new BridgeError("invalid_request", `application ${action} requires value or value_resource`);
  }
}

function validateActionDispatchArguments(surface, action, target, args) {
  clampInt(args.timeout_seconds, 30, 1, 60);
  clampInt(args.verify_timeout_seconds, 5, 1, 60);
  if (surface === "browser") {
    const inputMode = normalizeInputMode(args.input_mode);
    const waitFor = normalizeNavigationWait(args.wait_for);
    clampInt(args.element_timeout_seconds, 10, 1, 60);
    clampInt(args.post_max_elements, 180, 1, 1000);
    clampInt(args.post_max_ax_nodes, 180, 1, 2000);
    if (args.url !== undefined) requiredString(args.url, "url", 32768);
    if (args.value !== undefined) requiredStringAllowEmpty(args.value, "value", 131072);
    if (args.value_resource !== undefined) requiredResource(args.value_resource);
    if (args.key !== undefined) requiredString(args.key, "key", 100);
    if (inputMode === "dom" && (action === "drag" || action === "scroll")) {
      throw new BridgeError("invalid_request", `snapshot-bound ${action} requires trusted browser input`);
    }
    if (inputMode === "dom" && target?.kind === "point") {
      throw new BridgeError("invalid_request", "snapshot-bound visual point actions require trusted input");
    }
    if (waitFor !== "none" && (action === "drag" || action === "scroll")) {
      throw new BridgeError("invalid_request", `wait_for is not supported for ${action}; use expect.* post-conditions instead`);
    }
    if (waitFor !== "none" && target?.kind === "point") {
      throw new BridgeError("invalid_request", "wait_for is not supported for visual point dispatch; use expect.load_state or another post-condition");
    }
    return;
  }
  clampInt(args.post_max_elements, 200, 1, 500);
  clampInt(args.post_max_depth, 6, 1, 12);
  if (args.include_menus !== undefined && typeof args.include_menus !== "boolean") {
    throw new BridgeError("invalid_request", "include_menus must be boolean");
  }
  if (args.value !== undefined) {
    const value = requiredStringAllowEmpty(args.value, "value", 4000);
    if (action === "keystroke" && value.length === 0) throw new BridgeError("invalid_request", "application keystroke requires non-empty text");
  }
  if (args.value_resource !== undefined) requiredResource(args.value_resource);
  if (args.key !== undefined) requiredString(args.key, "key", 100);
}

function validateDragTargets(surface, target, destination) {
  if (!target || !destination) throw new BridgeError("invalid_request", `${surface} drag requires both target and destination`);
  if (surface === "application") {
    if (target.kind !== "point" || destination.kind !== "point") {
      throw new BridgeError("invalid_request", "application drag currently requires normalized point source and destination from the same window snapshot");
    }
    return;
  }
  if (target.kind !== destination.kind) {
    throw new BridgeError("invalid_request", "browser drag target and destination must both use refs or both use normalized points");
  }
}

function browserScrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
    throw new BridgeError("invalid_request", `${label} must be a finite number from -10000 to 10000`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function optionalApplicationFocusQuery(value) {
  if (value === undefined) return "";
  return requiredStringAllowEmpty(value, "focus_query", 1000);
}

function applicationPostFocusQuery(target) {
  if (!target) return undefined;
  const element = target.kind === "ref" ? target.element || {} : target.semantic_delivery?.element || {};
  const value = element.name || element.title || element.description || element.identifier || element.role || "";
  return String(value).trim().slice(0, 1000) || undefined;
}

function browserSnapshotIdentity(element) {
  const output = {};
  for (const field of BROWSER_SNAPSHOT_IDENTITY_FIELDS) {
    if (!Object.hasOwn(element || {}, field)) continue;
    const value = element[field];
    const valid = BROWSER_SNAPSHOT_BOOLEAN_IDENTITY_FIELDS.has(field) ? typeof value === "boolean" : typeof value === "string";
    if (!valid) throw staleSnapshot("browser snapshot target identity is malformed");
    output[field] = value;
  }
  return Object.keys(output).length ? output : null;
}

function browserSnapshotIdentityMatches(expected, element) {
  if (!expected || !element) return false;
  return Object.entries(expected).every(([field, value]) => {
    if (!Object.hasOwn(element, field)) return false;
    const actual = element[field];
    return typeof value === "boolean" ? typeof actual === "boolean" && actual === value
      : typeof actual === "string" && actual === value;
  });
}

function requiredResource(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) {
    throw new BridgeError("invalid_request", "value_resource is invalid");
  }
  return value;
}

function optionalPositiveInt(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new BridgeError("invalid_request", `${label} must be a positive integer`);
  return value;
}

function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new BridgeError("invalid_request", `expected an integer from ${min} to ${max}`);
  return value;
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requiredStringAllowEmpty(value, label, maxLength) {
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
    throw new BridgeError("invalid_request", `${label} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  return requiredBoolean(value, label);
}

function computerScreenshotFormat(value) {
  if (value === undefined) return "png";
  if (value !== "png" && value !== "jpeg") throw new BridgeError("invalid_request", "screenshot_format must be png or jpeg");
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new BridgeError("invalid_request", `${label} must be boolean`);
  return value;
}

function applicationScreenshotError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("screen recording") || message.includes("permission") || message.includes("not authorized")) {
    return "application window screenshot unavailable; Screen Recording permission may be required";
  }
  if (message.includes("no capturable on-screen window")) return "application has no capturable on-screen window";
  return "application window screenshot unavailable";
}

function applicationWindowRevalidationError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("accessibility") || message.includes("permission") || message.includes("not authorized")) {
    return "application window identity could not be revalidated; Accessibility permission may be required";
  }
  if (message.includes("no capturable on-screen window")) return "application window identity changed or became unavailable during capture";
  return "application window identity could not be revalidated during capture";
}

function browserObservationSemanticEpoch(observation) {
  const value = observation?.capture?.semantic_epoch;
  return typeof value === "string" && value && value.length <= 9000 && !value.includes("\0") ? value : "";
}

function privateBrowserHistoryEntryKey(value) {
  return typeof value === "string" && value && value.length <= 512 && !value.includes("\0") ? value : "";
}

function enforceBrowserHistoryDocumentPreflight(action, semanticEpoch, expectedHistoryEntryKey, currentDocument, documentStateError) {
  if (!BROWSER_DOCUMENT_BOUND_TARGETLESS_ACTIONS.has(action)) return;
  if (!semanticEpoch || !currentDocument?.document_epoch) {
    throw new BridgeError("unavailable", "cannot validate the browser document before this snapshot-bound history action; observe again", {
      details: { reason: "browser_document_preflight_unavailable", ...(documentStateError ? { detail: boundedError(documentStateError) } : {}) },
    });
  }
  if (!expectedHistoryEntryKey) {
    throw new BridgeError("unavailable", "cannot bind this snapshot to a browser history entry; observe again", {
      details: { reason: "browser_history_preflight_unavailable" },
    });
  }
  const currentHistoryEntryKey = privateBrowserHistoryEntryKey(currentDocument?._machine_history_entry_key);
  if (!currentHistoryEntryKey) {
    throw new BridgeError("unavailable", "cannot validate the browser history entry before this snapshot-bound history action; observe again", {
      details: { reason: "browser_history_preflight_unavailable" },
    });
  }
  if (currentHistoryEntryKey !== expectedHistoryEntryKey) throw staleSnapshot("browser history entry changed after the snapshot");
}

function boundedError(error) {
  return String(error?.message || error || "operation failed").replace(/\s+/g, " ").slice(0, 500);
}

function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.max(0, Number(milliseconds) || 0)); });
}
