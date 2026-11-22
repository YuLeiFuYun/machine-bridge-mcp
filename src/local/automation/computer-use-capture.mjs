import { createHash } from "node:crypto";
import { applicationCaptureCoherence, applicationScreenshotBytes, applicationScreenshotError, applicationWindowBinding, applicationWindowRevalidationError, sameApplicationWindowIdentity, staleSnapshot, applicationElementSupportsPointClick, prepareApplicationObservationElements } from "./computer-use-geometry.mjs";
import { clampInt, optionalApplicationFocusQuery, optionalBoolean, requiredString, requiredSurface, validateObserveArgs } from "./computer-use-contracts.mjs";
import { requiredComputerObserveRemainingTimeoutSeconds, browserObservationArgs, validateApplicationInspectionEvidence, validateBrowserObservationForSnapshot } from "./computer-use-policies.mjs";
import { optionalPrivateApplicationProcessGeneration, optionalPrivateApplicationProcessId, requiredPrivateApplicationProcessGeneration, requiredPrivateApplicationProcessId } from "./computer-use-verification.mjs";
import { buildBrowserObservation, extractBrowserPrivateBindings, projectSetOfMarks, renderSetOfMarksSvg } from "./computer-use-observation.mjs";
import { assertObservationResultFits, isResultLimitExceeded, omitApplicationScreenshotForResultBudget, omitBrowserScreenshotForResultBudget } from "./computer-use-result-budget.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";

// The overlay is an aid, not evidence. Cap it so a very large page cannot consume the whole
// observation result budget and turn a successful capture into a limit failure.
const MAX_SET_OF_MARKS_SVG_BYTES = 192 * 1024;

export async function captureComputerUse(ctx, args, context, operationDeadline = null) {
  const surface = requiredSurface(args.surface);
  validateObserveArgs(surface, args);
  if (surface === "browser") return captureBrowserObservation(ctx, args, context);
  return captureApplicationObservation(ctx, args, context, operationDeadline);
}

export async function captureApplicationScreenshot(ctx, { application, screenshotRequested, timeoutSeconds, captureDeadline }, context) {
  let screenshot = null;
  let screenshotError = "";
  if (screenshotRequested && typeof ctx.applications.captureApplication === "function") {
    try {
      screenshot = await ctx.applications.captureApplication({
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

function applyObservationMarks(observation, elements, wantsMarks, dimensions = {}) {
  if (!wantsMarks) return;
  const marks = projectSetOfMarks(elements);
  observation.set_of_marks = marks;
  observation.capture.marks_included = true;
  if (marks.length > 0) {
    const svg = renderSetOfMarksSvg(marks, {
      width: dimensions.width,
      height: dimensions.height,
    });
    if (Buffer.byteLength(svg) <= MAX_SET_OF_MARKS_SVG_BYTES) {
      observation.set_of_marks_svg = svg;
    } else {
      observation.set_of_marks_svg_omitted = "size_budget";
    }
  }
}

function fitObservationWithinBudget(observation, initialImages, omitScreenshot) {
  let imageContent = Array.isArray(initialImages) ? [...initialImages] : [];
  try {
    assertObservationResultFits(observation, imageContent);
    return imageContent;
  } catch (firstError) {
    if (!isResultLimitExceeded(firstError)) throw firstError;
    if (observation.set_of_marks_svg) {
      delete observation.set_of_marks_svg;
      observation.set_of_marks_svg_omitted = "size_budget";
      try {
        assertObservationResultFits(observation, imageContent);
        return imageContent;
      } catch (svgError) {
        if (!isResultLimitExceeded(svgError)) throw svgError;
      }
    }
    if (observation.set_of_marks) {
      delete observation.set_of_marks;
      if (observation.capture) observation.capture.marks_included = false;
      observation.set_of_marks_omitted_reason = "result_budget";
      try {
        assertObservationResultFits(observation, imageContent);
        return imageContent;
      } catch (marksError) {
        if (!isResultLimitExceeded(marksError) || !imageContent.length) throw marksError;
      }
    }
    if (!imageContent.length) throw firstError;
    omitScreenshot(observation);
    imageContent = [];
    assertObservationResultFits(observation, imageContent);
    return imageContent;
  }
}

export async function captureBrowserObservation(ctx, args, context) {
  const captured = await ctx.browser.observeComputer(browserObservationArgs(args), context);
  ctx.throwIfCancelled(context);
  const privateState = extractBrowserPrivateBindings(captured);
  validateBrowserObservationForSnapshot(captured);
  const observation = buildBrowserObservation(captured, args);
  const wantsMarks = args?.set_of_marks === true || args?.include_marks === true;
  if (wantsMarks && observation?.semantic?.frames) {
    const vp = observation.semantic?.viewport || {};
    const topFrameElements = observation.semantic.frames
      .filter((frame) => frame.frame_id === 0 || frame.frame_id === undefined)
      .flatMap((frame) => frame.elements || []);
    applyObservationMarks(
      observation,
      topFrameElements,
      true,
      { width: vp.width, height: vp.height },
    );
  }
  const imageContent = fitObservationWithinBudget(
    observation,
    Array.isArray(captured.imageContent) ? captured.imageContent : [],
    omitBrowserScreenshotForResultBudget,
  );
  observation.snapshot_id = ctx.snapshots.add(observation, privateState);
  return { observation, privateState, imageContent };
}

export async function captureApplicationObservation(ctx, args, context, operationDeadline = null) {
  const application = requiredString(args.application, "application", 300);
  const maxElements = clampInt(args.max_elements, 200, 1, 500);
  const maxDepth = clampInt(args.max_depth, 6, 1, 12);
  const includeValues = optionalBoolean(args.include_values, "include_values", false);
  const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
  const focusQuery = optionalApplicationFocusQuery(args.focus_query);
  const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 60);
  const captureDeadline = operationDeadline || createMonotonicDeadline(timeoutSeconds * 1000, ctx.now);
  const screenshotRequested = optionalBoolean(args.include_screenshot, "include_screenshot", true);
  const {
    screenshotError, image, screenshotSource, screenshotSha256, windowBinding,
    screenshotProcessId, screenshotProcessGeneration,
  } = await captureApplicationScreenshot(ctx, { application, screenshotRequested, timeoutSeconds, captureDeadline }, context);
  const inspected = await ctx.applications.inspectApplication({
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
  const { windowCoherent, windowRevalidationError } = await revalidateApplicationWindow(ctx, {
    application,
    windowBinding,
    inspected,
    applicationProcessId,
    applicationProcessGeneration,
    timeoutSeconds,
    captureDeadline,
    context,
  });
  const visualPointCapability = ctx.applications.visualPointCapability();
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
      screenshot: typeof ctx.applications.captureApplication === "function",
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
  const wantsMarks = args?.set_of_marks === true || args?.include_marks === true;
  applyObservationMarks(
    observation,
    observation.semantic.elements,
    wantsMarks,
    { width: prepared.selection?.window_size?.width, height: prepared.selection?.window_size?.height },
  );
  const privateState = {
    application_process_id: applicationProcessId,
    application_process_generation: applicationProcessGeneration,
    application_ref_bindings: prepared.bindings,
    application_inspection: { max_depth: maxDepth, include_menus: includeMenus },
  };
  if (windowBinding) privateState.application_window_binding = windowBinding;
  const imageContent = fitObservationWithinBudget(
    observation,
    image ? [image] : [],
    omitApplicationScreenshotForResultBudget,
  );
  ctx.throwIfCancelled(context);
  observation.snapshot_id = ctx.snapshots.add(observation, privateState);
  return { observation, privateState, imageContent };
}

export async function revalidateApplicationWindow(ctx, {
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
  if (typeof ctx.applications.inspectApplicationWindow !== "function") {
    return { windowCoherent: null, windowRevalidationError: "" };
  }
  const revalidationTimeoutSeconds = requiredComputerObserveRemainingTimeoutSeconds(captureDeadline, timeoutSeconds);
  try {
    const currentWindow = await ctx.applications.inspectApplicationWindow({
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
