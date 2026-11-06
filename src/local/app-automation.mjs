import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createToolAuthorizer } from "./policy.mjs";
import { BridgeError } from "./errors.mjs";
import {
  APPLICATION_OPERATION_REASON, applicationAutomationBoundaryError,
  applicationOperationReason, applicationProcessIdentityChanged, applicationVisualPreflightUnavailable,
  applicationVisualSnapshotChanged,
} from "./computer-use-dispatch-settlement.mjs";
import { MACOS_UI_JXA } from "./app-automation-macos-jxa.mjs";
import {
  DEFAULT_APPLICATION_CACHE_MS, MAX_APPLICATIONS, MAX_APPLICATION_SCREENSHOT_BYTES,
  MAX_UI_DEPTH, MAX_UI_ELEMENTS, MAX_VALUE_VERIFICATION_HANDLES, VALUE_VERIFICATION_TTL_MS,
  applicationAccessibilityOutcomeUnknown, applicationKeyboardOutcomeUnknown, applicationLaunchOutcomeUnknown,
  applicationProcessName, applicationScrollDelta, applicationText, applicationVisualInputOutcomeUnknown,
  applicationWindowPoint, assertMacAccessibility, clampInt, desktopAutomationCapabilities, isPng,
  listLinuxApplications, listMacApplications, listWindowsApplications, normalizeAppAction,
  normalizeApplicationKeyPress, normalizeBackgroundVisualBackend, normalizeUiSelector, normalizedCoordinate,
  optionalBoolean, optionalExpectedProcessGeneration, optionalExpectedProcessId, optionalProcessGeneration,
  optionalString, powershellSingleQuotedLiteral, requiredApplication, requiredApplicationValueVerificationHandle,
  requiredPositiveInteger, requiredResourceName, requiredSha256, requiredWindowBounds, safeSelectedMacWindow,
  sameWindowBoundsNode, selectMacWindow,
} from "./app-automation-support.mjs";

export class AppAutomationManager {
  constructor({ policy, authorizeTool = null, displayPath, projectCapabilities = (capabilities) => capabilities, runProcess, readResourceText, throwIfCancelled = () => {}, platform = process.platform, home = homedir(), applicationRoots = null, applicationCacheMs = DEFAULT_APPLICATION_CACHE_MS, now = () => performance.now(), backgroundVisualBackend = process.env.MBM_MACOS_BACKGROUND_VISUAL_BACKEND || "disabled", backgroundInputService = null }) {
    this.policy = policy || {};
    this.authorizeTool = createToolAuthorizer(this.policy, authorizeTool);
    this.displayPath = displayPath;
    this.projectCapabilities = projectCapabilities;
    this.runProcess = runProcess;
    this.readResourceText = readResourceText;
    this.throwIfCancelled = throwIfCancelled;
    this.platform = platform;
    this.home = home;
    this.applicationRoots = applicationRoots;
    this.applicationCacheMs = Math.max(0, Number(applicationCacheMs) || 0);
    this.now = now;
    this.applicationCache = null;
    this.backgroundVisualBackend = normalizeBackgroundVisualBackend(backgroundVisualBackend);
    this.backgroundInputService = backgroundInputService;
    this.valueVerificationStore = new Map();
  }

  visualPointCapability() {
    const configured = this.platform === "darwin" && this.backgroundVisualBackend === "skylight-experimental";
    const serviceStatus = configured && typeof this.backgroundInputService?.status === "function"
      ? this.backgroundInputService.status()
      : null;
    const injectedServiceWithoutStatus = configured && this.backgroundInputService !== null && serviceStatus === null;
    return {
      available: configured && (serviceStatus?.available === true || injectedServiceWithoutStatus),
      configured,
      probed: serviceStatus?.probed === true || injectedServiceWithoutStatus,
      backend: configured ? "skylight-experimental" : "disabled",
      experimental: configured,
      non_disruptive_intent: configured,
      error_class: configured && serviceStatus?.error ? serviceStatus.error : "",
    };
  }

  async probeVisualPointCapability(context = {}) {
    if (this.backgroundVisualBackend !== "skylight-experimental" || !this.backgroundInputService) return this.visualPointCapability();
    if (typeof this.backgroundInputService.probe === "function") {
      await this.backgroundInputService.probe(context).catch(() => { /* Optional capability probing must not fail application inventory. */ });
    }
    return this.visualPointCapability();
  }

  capabilities() {
    return {
      ...desktopAutomationCapabilities(this.platform),
      background_visual_point: this.visualPointCapability(),
    };
  }

  async listApplications(args = {}, context = {}) {
    this.authorizeTool("list_local_applications");
    this.throwIfCancelled(context);
    const query = optionalString(args.query, "query", 1000).trim().toLowerCase();
    const limit = clampInt(args.max_results, 200, 1, MAX_APPLICATIONS);
    const discovery = await this.discoverApplications(context);
    const matched = discovery.applications
      .filter((item) => !query || `${item.name}\n${item.id}\n${item.path}`.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name));
    const filtered = matched
      .slice(0, limit)
      .map((item) => ({ ...item, path: item.path ? this.displayPath(item.path, context) : "" }));
    return {
      platform: this.platform,
      applications: filtered,
      truncated: discovery.truncated || matched.length > limit,
      scanned_entries: discovery.visitedEntries,
      warnings: discovery.warnings.map((warning) => ({
        path: this.displayPath(warning.path, context), error_class: warning.error_class,
      })),
      capabilities: this.projectCapabilities(this.capabilities(), context),
    };
  }

  async discoverApplications(context = {}) {
    const now = this.now();
    if (this.applicationCache && now - this.applicationCache.createdAt < this.applicationCacheMs) {
      return this.applicationCache.result;
    }
    const result = await this.scanApplications(context);
    this.throwIfCancelled(context);
    this.applicationCache = { createdAt: this.now(), result };
    return result;
  }

  async scanApplications(context = {}) {
    if (this.platform === "darwin") {
      return listMacApplications(this.applicationRoots || ["/Applications", "/System/Applications", join(this.home, "Applications")], context, this.throwIfCancelled);
    }
    if (this.platform === "win32") return listWindowsApplications(this.applicationRoots, this.home, context, this.throwIfCancelled);
    return listLinuxApplications(this.applicationRoots, this.home, context, this.throwIfCancelled);
  }

  async resolveApplicationReference(application, context = {}) {
    if (application.includes("/") || application.includes("\\")) return application;
    const lower = application.toLowerCase();
    const match = (await this.discoverApplications(context)).applications.find((item) => item.name.toLowerCase() === lower || item.id.toLowerCase() === lower);
    return match?.id || application;
  }

  async openApplication(args = {}, context = {}) {
    this.authorizeTool("open_local_application");
    const application = requiredApplication(args.application);
    const target = optionalString(args.target, "target", 32768);
    const background = optionalBoolean(args.background, "background", false);
    this.throwIfCancelled(context);
    const resolvedApplication = this.platform === "darwin" ? application : await this.resolveApplicationReference(application, context);
    let command;
    if (this.platform === "darwin") {
      const argv = ["-a", application];
      if (background) argv.push("-g");
      if (target) argv.push(target);
      command = { cmd: "open", argv };
    } else if (this.platform === "win32") {
      const fileLiteral = powershellSingleQuotedLiteral(resolvedApplication);
      const targetFragment = target ? ` -ArgumentList ${powershellSingleQuotedLiteral(target)}` : "";
      command = { cmd: "powershell.exe", argv: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath ${fileLiteral}${targetFragment}`] };
    } else if (resolvedApplication.toLowerCase().endsWith(".desktop")) {
      command = { cmd: "gio", argv: ["launch", resolvedApplication, ...(target ? [target] : [])] };
    } else {
      command = target
        ? { cmd: resolvedApplication, argv: [target] }
        : { cmd: resolvedApplication, argv: [] };
    }
    this.throwIfCancelled(context);
    let result;
    try {
      result = await this.runProcess(command.cmd, command.argv, clampInt(args.timeout_seconds, 30, 1, 120) * 1000, false, 256 * 1024, context, undefined, null, { nonReplayableMutation: true });
    } catch (error) {
      if (error instanceof BridgeError && error.details?.reason === "process_outcome_unknown_after_spawn") throw applicationLaunchOutcomeUnknown(error);
      if (error instanceof BridgeError && error.details?.reason === "process_failed_before_spawn") {
        throw new BridgeError("unavailable", "application launch unavailable before dispatch", {
          retryable: true, details: { reason: "application_launch_unavailable_before_dispatch" },
        });
      }
      throw error;
    }
    const publicResolvedApplication = /[\\/]/.test(resolvedApplication) ? this.displayPath(resolvedApplication, context) : resolvedApplication;
    return { application, resolved_application: publicResolvedApplication, target, platform: this.platform, ...result };
  }

  async inspectApplication(args = {}, context = {}) {
    this.authorizeTool("inspect_local_application");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const includeProcessId = optionalBoolean(args.include_process_id, "include_process_id", false);
    const includeValues = optionalBoolean(args.include_values, "include_values", false);
    const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
    const includeGeometry = optionalBoolean(args.include_geometry, "include_geometry", false);
    const includeWindowState = optionalBoolean(args.include_window_state, "include_window_state", false);
    const includeProcessGeneration = includeProcessId || expectedProcessGeneration !== null;
    const payload = {
      operation: "inspect",
      application: processName,
      expectedProcessId,
      expectedProcessGeneration,
      includeProcessGeneration,
      maxDepth: clampInt(args.max_depth, 6, 1, MAX_UI_DEPTH),
      maxElements: clampInt(args.max_elements, 200, 1, MAX_UI_ELEMENTS),
      includeValues,
      includeMenus,
      includeGeometry,
      includeWindowState,
    };
    const result = await this.runJxa(payload, clampInt(args.timeout_seconds, 30, 1, 120), context);
    const processId = requiredPositiveInteger(result?.process_id, "application process pid");
    const processGeneration = optionalProcessGeneration(result?.process_generation, "application process generation");
    const machineWindow = includeWindowState ? safeSelectedMacWindow(result?.window_state) : null;
    const { process_id: _processId, process_generation: _processGeneration, window_state: _windowState, ...publicResult } = result || {};
    if (expectedProcessId && processId !== expectedProcessId) throw applicationProcessIdentityChanged("application process changed before operation");
    if (expectedProcessGeneration && processGeneration !== expectedProcessGeneration) throw applicationProcessIdentityChanged("application process generation changed before operation");
    if (includeProcessId && !processGeneration) throw new Error("application process generation is unavailable during Accessibility inspection");
    return {
      application,
      process_name: processName,
      platform: this.platform,
      accessibility_permission_required: true,
      ...publicResult,
      ...(includeProcessId ? { _machine_process_id: processId, _machine_process_generation: processGeneration } : {}),
      ...(includeWindowState ? {
        _machine_window_state_checked: true,
        ...(machineWindow ? { _machine_window: machineWindow } : {}),
      } : {}),
    };
  }

  async captureApplication(args = {}, context = {}) {
    this.authorizeTool("computer_observe");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const captured = await this.captureMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration);
    const background_visual_point = await this.probeVisualPointCapability(context);
    return {
      application, process_name: processName, platform: this.platform, background_visual_point,
      _machine_process_id: captured.window.process_id,
      _machine_process_generation: captured.window.process_generation,
      screenshot: { mime_type: "image/png", data: captured.bytes.toString("base64"), source: "macos_window", byte_length: captured.bytes.length, bounds: captured.window.bounds || null },
      window: { id: captured.window.window_id, bounds: captured.window.bounds || null },
      screen_recording_permission_required: true,
    };
  }

  async inspectApplicationWindow(args = {}, context = {}) {
    this.authorizeTool("computer_observe");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const includeProcessId = optionalBoolean(args.include_process_id, "include_process_id", false);
    const window = await this.resolveMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration);
    return {
      application,
      process_name: processName,
      platform: this.platform,
      window: { id: window.window_id, bounds: window.bounds || null },
      ...(includeProcessId ? {
        _machine_process_id: window.process_id,
        _machine_process_generation: window.process_generation,
      } : {}),
    };
  }

  async pointApplication(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    assertMacAccessibility(this.platform);
    const visualCapability = this.visualPointCapability();
    if (!visualCapability.available) throw new Error("macOS background visual point input is disabled or unavailable");
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const normalizedX = normalizedCoordinate(args.normalized_x, "normalized_x");
    const normalizedY = normalizedCoordinate(args.normalized_y, "normalized_y");
    const clickCount = args.click_count === undefined ? 1 : requiredPositiveInteger(args.click_count, "click_count");
    if (clickCount > 2) throw new Error("application visual click_count must be 1 or 2");
    const expectedWindowId = requiredPositiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const captured = await this.captureValidatedVisualTarget({
      processName, timeoutSeconds, expectedProcessId, expectedProcessGeneration,
      expectedWindowId, expectedBounds, expectedScreenshotSha256,
    }, context);
    const screenX = expectedBounds.x + normalizedX * expectedBounds.width;
    const screenY = expectedBounds.y + normalizedY * expectedBounds.height;
    const localX = normalizedX * expectedBounds.width;
    const localY = normalizedY * expectedBounds.height;
    const result = await this.dispatchVisualInput("click", {
      pid: captured.window.process_id,
      process_generation: captured.window.process_generation,
      window_id: expectedWindowId, screen_x: screenX, screen_y: screenY,
      local_x: localX, local_y: localY,
      ...(clickCount === 1 ? {} : { click_count: clickCount }),
      window_x: expectedBounds.x, window_y: expectedBounds.y,
      window_width: expectedBounds.width, window_height: expectedBounds.height,
      timeout_seconds: timeoutSeconds,
    }, context);
    return {
      application, process_name: processName, ...result,
      normalized_point: { x: normalizedX, y: normalizedY },
    };
  }

  async dragApplication(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    assertMacAccessibility(this.platform);
    const visualCapability = this.visualPointCapability();
    if (!visualCapability.available || typeof this.backgroundInputService?.drag !== "function") {
      throw new Error("macOS background visual drag input is disabled or unavailable");
    }
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const normalizedX = normalizedCoordinate(args.normalized_x, "normalized_x");
    const normalizedY = normalizedCoordinate(args.normalized_y, "normalized_y");
    const destinationNormalizedX = normalizedCoordinate(args.destination_normalized_x, "destination_normalized_x");
    const destinationNormalizedY = normalizedCoordinate(args.destination_normalized_y, "destination_normalized_y");
    const expectedWindowId = requiredPositiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const captured = await this.captureValidatedVisualTarget({
      processName, timeoutSeconds, expectedProcessId, expectedProcessGeneration,
      expectedWindowId, expectedBounds, expectedScreenshotSha256,
    }, context);
    const sourcePoint = applicationWindowPoint(expectedBounds, normalizedX, normalizedY);
    const destinationPoint = applicationWindowPoint(expectedBounds, destinationNormalizedX, destinationNormalizedY);
    const result = await this.dispatchVisualInput("drag", {
      pid: captured.window.process_id,
      process_generation: captured.window.process_generation,
      window_id: expectedWindowId,
      screen_x: sourcePoint.screen_x, screen_y: sourcePoint.screen_y,
      local_x: sourcePoint.local_x, local_y: sourcePoint.local_y,
      destination_screen_x: destinationPoint.screen_x, destination_screen_y: destinationPoint.screen_y,
      destination_local_x: destinationPoint.local_x, destination_local_y: destinationPoint.local_y,
      window_x: expectedBounds.x, window_y: expectedBounds.y,
      window_width: expectedBounds.width, window_height: expectedBounds.height,
      timeout_seconds: timeoutSeconds,
    }, context);
    return {
      application, process_name: processName, ...result,
      normalized_point: { x: normalizedX, y: normalizedY },
      destination_normalized_point: { x: destinationNormalizedX, y: destinationNormalizedY },
    };
  }

  async scrollApplication(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    assertMacAccessibility(this.platform);
    const visualCapability = this.visualPointCapability();
    if (!visualCapability.available || typeof this.backgroundInputService?.scroll !== "function") {
      throw new Error("macOS background visual scroll input is disabled or unavailable");
    }
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const normalizedX = normalizedCoordinate(args.normalized_x, "normalized_x");
    const normalizedY = normalizedCoordinate(args.normalized_y, "normalized_y");
    const deltaX = applicationScrollDelta(args.delta_x, "delta_x");
    const deltaY = applicationScrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new Error("application visual scroll requires a non-zero delta_x or delta_y");
    const expectedWindowId = requiredPositiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const captured = await this.captureValidatedVisualTarget({
      processName, timeoutSeconds, expectedProcessId, expectedProcessGeneration,
      expectedWindowId, expectedBounds, expectedScreenshotSha256,
    }, context);
    const point = applicationWindowPoint(expectedBounds, normalizedX, normalizedY);
    const result = await this.dispatchVisualInput("scroll", {
      pid: captured.window.process_id,
      process_generation: captured.window.process_generation,
      window_id: expectedWindowId,
      screen_x: point.screen_x, screen_y: point.screen_y,
      local_x: point.local_x, local_y: point.local_y,
      delta_x: deltaX, delta_y: deltaY,
      window_x: expectedBounds.x, window_y: expectedBounds.y,
      window_width: expectedBounds.width, window_height: expectedBounds.height,
      timeout_seconds: timeoutSeconds,
    }, context);
    return {
      application, process_name: processName, ...result,
      normalized_point: { x: normalizedX, y: normalizedY },
      scroll_delta: { delta_x: deltaX, delta_y: deltaY },
    };
  }

  async captureValidatedVisualTarget(target, context) {
    const { processName, timeoutSeconds, expectedProcessId, expectedProcessGeneration } = target;
    this.throwIfCancelled(context);
    let captured;
    try { captured = await this.captureMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration); }
    catch (error) {
      if (applicationOperationReason(error) === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) throw error;
      throw applicationVisualPreflightUnavailable("application visual snapshot unavailable before dispatch", error);
    }
    const actualSha256 = createHash("sha256").update(captured.bytes).digest("hex");
    if (captured.window.window_id !== target.expectedWindowId
        || !sameWindowBoundsNode(captured.window.bounds, target.expectedBounds)
        || actualSha256 !== target.expectedScreenshotSha256) {
      throw applicationVisualSnapshotChanged("application visual snapshot changed before dispatch");
    }
    this.throwIfCancelled(context);
    return captured;
  }

  async dispatchVisualInput(operation, input, context) {
    let result;
    try { result = await this.backgroundInputService[operation](input, context); }
    catch (error) {
      if (error instanceof BridgeError && error.code === "cancelled") throw error;
      const reason = applicationOperationReason(error);
      if (reason === APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN) throw applicationVisualInputOutcomeUnknown(error);
      if (reason === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) {
        throw applicationProcessIdentityChanged("application process generation changed before operation", error);
      }
      if (reason === APPLICATION_OPERATION_REASON.INPUT_PREFLIGHT_UNAVAILABLE
          || reason === APPLICATION_OPERATION_REASON.VISUAL_PREFLIGHT_UNAVAILABLE) {
        throw applicationVisualPreflightUnavailable("application visual input unavailable before dispatch", error);
      }
      throw applicationVisualInputOutcomeUnknown(error);
    }
    return {
      ok: result?.ok === true,
      coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
      input_transport: typeof result?.input_transport === "string" ? result.input_transport : "",
      experimental_backend: true,
      focus_without_raise: result?.focus_without_raise === true,
      front_window_validated: result?.front_window_validated === true,
      cursor_preserved: result?.cursor_preserved === true,
      frontmost_restored: result?.frontmost_restored === true,
    };
  }

  async captureMacWindow(processName, timeoutSeconds, context, expectedProcessId = null, expectedProcessGeneration = null) {
    const window = await this.resolveMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration);
    const directory = await mkdtemp(join(tmpdir(), "mbm-app-shot-"));
    const outputPath = join(directory, "window.png");
    try {
      await this.runProcess("/usr/sbin/screencapture", ["-x", "-o", "-l", String(window.window_id), outputPath], timeoutSeconds * 1000, false, 64 * 1024, context, undefined, null);
      const handle = await open(outputPath, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 8 || info.size > MAX_APPLICATION_SCREENSHOT_BYTES) throw new Error("application screenshot size is invalid");
        const bytes = await handle.readFile();
        if (!isPng(bytes)) throw new Error("application screenshot is not a PNG image");
        return { window, bytes };
      } finally {
        await handle.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => { /* Screenshot staging cleanup is best-effort after settlement. */ });
    }
  }

  async resolveMacWindow(processName, timeoutSeconds, context, expectedProcessId = null, expectedProcessGeneration = null) {
    const windowState = await this.runJxa({
      operation: "window_candidates",
      application: processName,
      expectedProcessId,
      expectedProcessGeneration,
      includeProcessGeneration: true,
    }, timeoutSeconds, context);
    const window = selectMacWindow(windowState);
    if (expectedProcessId && window.process_id !== expectedProcessId) throw applicationProcessIdentityChanged("application process changed before operation");
    if (expectedProcessGeneration && window.process_generation !== expectedProcessGeneration) {
      throw applicationProcessIdentityChanged("application process generation changed before operation");
    }
    if (!window.process_generation) throw new Error("application process generation is unavailable during window selection");
    return window;
  }

  async operateApplication(args = {}, context = {}) {
    this.authorizeTool("operate_local_application");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const action = normalizeAppAction(args.action);
    const selector = action === "activate" ? null : normalizeUiSelector(args.selector || {});
    const expectedWindowBounds = args.expected_window_bounds === undefined ? null : requiredWindowBounds(args.expected_window_bounds);
    const expectedElementBounds = args.expected_element_bounds === undefined ? null : requiredWindowBounds(args.expected_element_bounds);
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    const maxDepth = clampInt(args.max_depth, 8, 1, MAX_UI_DEPTH);
    const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
    const { key, value, keyboardAction } = await this.resolveApplicationActionInput(args, action);
    const payload = {
      operation: "act",
      application: processName,
      expectedProcessId,
      expectedProcessGeneration,
      action: keyboardAction ? "focus" : action,
      selector,
      value: keyboardAction ? null : value,
      key: null,
      maxDepth,
      maxElements: MAX_UI_ELEMENTS,
      includeMenus,
      includeProcessGeneration: true,
      expectedWindowBounds,
      expectedElementBounds,
    };
    const result = await this.runJxa(payload, timeoutSeconds, context, { mutating: true });
    if (keyboardAction) {
      Object.assign(result, await this.dispatchPreparedApplicationKeyboard({
        action, key, value, expectedProcessId, expectedProcessGeneration, result, timeoutSeconds,
      }, context));
    }
    const { process_id: _processId, process_generation: _processGeneration, ...publicResult } = result || {};
    const valueVerificationHandle = this.retainApplicationVerificationValue(args, action, value, result);
    return {
      application,
      process_name: processName,
      action,
      selector,
      value_source: args.value_resource !== undefined ? "local-resource" : value === null ? "none" : "mcp-argument",
      value_exposed: false,
      ...(valueVerificationHandle ? { _machine_value_verification_handle: valueVerificationHandle } : {}),
      ...publicResult,
    };
  }

  async resolveApplicationActionInput(args, action) {
    const textAction = action === "set_value" || action === "keystroke";
    if (action === "key_press" && args.key === undefined) throw new Error("application key_press requires key");
    if (action !== "key_press" && args.key !== undefined) throw new Error(`application ${action} does not accept key`);
    const key = action === "key_press" ? normalizeApplicationKeyPress(args.key) : null;
    if (args.value !== undefined && args.value_resource !== undefined) throw new Error("value and value_resource are mutually exclusive");
    if (!textAction && (args.value !== undefined || args.value_resource !== undefined)) {
      throw new Error(`application ${action} does not accept value or value_resource`);
    }
    if (textAction && args.value === undefined && args.value_resource === undefined) {
      throw new Error(`application ${action} requires value or value_resource`);
    }
    let value = args.value === undefined ? null : applicationText(args.value, "application action value");
    if (textAction && args.value_resource !== undefined) {
      value = applicationText(await this.readResourceText(requiredResourceName(args.value_resource)), "application resource value");
    }
    if (action === "keystroke" && value === "") throw new Error("application keystroke requires non-empty text");
    const keyboardAction = action === "keystroke" || action === "key_press";
    if (keyboardAction && (!this.backgroundInputService
        || typeof this.backgroundInputService.keystroke !== "function"
        || typeof this.backgroundInputService.keyPress !== "function")) {
      throw new Error("macOS PID keyboard input unavailable before dispatch");
    }
    return { key, value, keyboardAction };
  }

  async dispatchPreparedApplicationKeyboard(input, context) {
    const resultProcessId = requiredPositiveInteger(input.result?.process_id, "application process pid");
    const resultProcessGeneration = optionalProcessGeneration(input.result?.process_generation, "application process generation");
    if (input.result?.element?.focused !== true) throw new Error("application keyboard target could not become focused before dispatch");
    if (!input.expectedProcessGeneration && !resultProcessGeneration) {
      throw new Error("application process generation is unavailable before keyboard dispatch");
    }
    this.throwIfCancelled(context);
    try {
      const keyboardResult = input.action === "keystroke"
        ? await this.backgroundInputService.keystroke({
            pid: input.expectedProcessId || resultProcessId,
            process_generation: input.expectedProcessGeneration || resultProcessGeneration,
            text: input.value,
            timeout_seconds: input.timeoutSeconds,
          }, context)
        : await this.backgroundInputService.keyPress({
            pid: input.expectedProcessId || resultProcessId,
            process_generation: input.expectedProcessGeneration || resultProcessGeneration,
            key: input.key,
            timeout_seconds: input.timeoutSeconds,
          }, context);
      return { input_transport: keyboardResult.input_transport, focus_prepared: true };
    } catch (error) {
      if (error instanceof BridgeError && error.code === "cancelled") throw error;
      const reason = applicationOperationReason(error);
      if (reason === APPLICATION_OPERATION_REASON.PROCESS_IDENTITY_CHANGED) {
        throw applicationProcessIdentityChanged("application process generation changed before operation", error);
      }
      if (reason === APPLICATION_OPERATION_REASON.INPUT_OUTCOME_UNKNOWN) {
        throw applicationKeyboardOutcomeUnknown(input.action, error);
      }
      throw error;
    }
  }

  retainApplicationVerificationValue(args, action, value, result) {
    if (action !== "set_value" || args.value_resource === undefined || args.retain_value_verification !== true
        || value === null || result?.ok !== true || result?.element?.sensitive !== false) return "";
    return this.retainApplicationValue(value);
  }

  async verifyApplicationValue(args = {}, context = {}) {
    this.authorizeTool("computer_act");
    assertMacAccessibility(this.platform);
    const application = requiredApplication(args.application);
    const processName = applicationProcessName(application);
    const selector = normalizeUiSelector(args.selector || {});
    const expectedWindowBounds = args.expected_window_bounds === undefined ? null : requiredWindowBounds(args.expected_window_bounds);
    const expectedElementBounds = args.expected_element_bounds === undefined ? null : requiredWindowBounds(args.expected_element_bounds);
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    let value = args.value === undefined ? null : applicationText(args.value, "application verification value");
    let valueSource = value === null ? "none" : "mcp-argument";
    if (args.value_verification_handle !== undefined) {
      if (value !== null || args.value_resource !== undefined) throw new Error("value_verification_handle is mutually exclusive with value and value_resource");
      value = this.takeApplicationValue(args.value_verification_handle);
      valueSource = "retained-action-value";
    } else if (args.value_resource !== undefined) {
      if (value !== null) throw new Error("value and value_resource are mutually exclusive");
      value = applicationText(await this.readResourceText(requiredResourceName(args.value_resource)), "application resource value");
      valueSource = "local-resource";
    }
    if (value === null) throw new Error("application value verification requires value or value_resource");
    const includeMenus = optionalBoolean(args.include_menus, "include_menus", false);
    const result = await this.runJxa({
      operation: "verify_value",
      application: processName,
      expectedProcessId,
      expectedProcessGeneration,
      selector,
      value,
      maxDepth: clampInt(args.max_depth, 8, 1, MAX_UI_DEPTH),
      maxElements: MAX_UI_ELEMENTS,
      includeMenus,
      expectedWindowBounds,
      expectedElementBounds,
    }, clampInt(args.timeout_seconds, 30, 1, 120), context);
    return {
      application,
      process_name: processName,
      selector,
      value_source: valueSource,
      value_exposed: false,
      supported: result?.supported === true,
      matched: result?.matched === true,
      matched_count: Number.isSafeInteger(result?.matched_count) && result.matched_count >= 0 ? result.matched_count : 0,
      selected_index: Number.isInteger(result?.selected_index) ? result.selected_index : null,
      reason: typeof result?.reason === "string" ? result.reason : "",
    };
  }

  retainApplicationValue(value) {
    this.pruneApplicationValues();
    while (this.valueVerificationStore.size >= MAX_VALUE_VERIFICATION_HANDLES) {
      this.valueVerificationStore.delete(this.valueVerificationStore.keys().next().value);
    }
    let handle = `av_${randomBytes(18).toString("base64url")}`;
    while (this.valueVerificationStore.has(handle)) handle = `av_${randomBytes(18).toString("base64url")}`;
    const retainedValue = applicationText(value, "application retained verification value");
    this.valueVerificationStore.set(handle, { value: retainedValue, expires_at: this.now() + VALUE_VERIFICATION_TTL_MS });
    return handle;
  }

  takeApplicationValue(rawHandle) {
    this.pruneApplicationValues();
    const handle = requiredApplicationValueVerificationHandle(rawHandle);
    const record = this.valueVerificationStore.get(handle) || null;
    this.valueVerificationStore.delete(handle);
    if (!record) throw new Error("application value verification handle is missing or expired");
    return record.value;
  }

  discardApplicationValueVerification(rawHandle) {
    if (typeof rawHandle !== "string" || !/^av_[A-Za-z0-9_-]{24,80}$/.test(rawHandle)) return false;
    return this.valueVerificationStore.delete(rawHandle);
  }

  pruneApplicationValues() {
    const now = this.now();
    for (const [handle, record] of this.valueVerificationStore) {
      if (typeof record?.expires_at !== "number" || !Number.isFinite(record.expires_at) || record.expires_at <= now) {
        this.valueVerificationStore.delete(handle);
      }
    }
  }

  async runJxa(payload, timeoutSeconds, context, { mutating = false } = {}) {
    const input = `${JSON.stringify(payload)}\n`;
    this.throwIfCancelled(context);
    let result;
    try {
      result = await this.runProcess(
        "osascript",
        ["-l", "JavaScript", "-e", MACOS_UI_JXA],
        timeoutSeconds * 1000,
        mutating,
        1024 * 1024,
        context,
        undefined,
        input,
        mutating ? { nonReplayableMutation: true } : {},
      );
    } catch (error) {
      if (mutating && error instanceof BridgeError && error.details?.reason === "process_outcome_unknown_after_spawn") {
        throw applicationAccessibilityOutcomeUnknown(error);
      }
      if (error instanceof BridgeError && error.details?.reason === "process_failed_before_spawn") {
        throw new BridgeError("unavailable", "application Accessibility helper unavailable before dispatch", {
          retryable: true, details: { reason: "application_accessibility_helper_unavailable_before_dispatch" },
        });
      }
      throw error;
    }
    if (mutating && result.code !== 0) throw applicationAccessibilityOutcomeUnknown();
    const output = result.stdout.trim();
    if (!output) {
      if (mutating) throw applicationAccessibilityOutcomeUnknown(new Error("missing helper settlement"));
      throw new Error("macOS accessibility helper returned no JSON output");
    }
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      if (mutating) throw applicationAccessibilityOutcomeUnknown(error);
      throw new Error("macOS accessibility helper returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (mutating) throw applicationAccessibilityOutcomeUnknown();
      throw new Error("macOS accessibility helper returned an invalid settlement object");
    }
    if (Object.hasOwn(parsed, "error")) {
      if (typeof parsed.error !== "string" || !parsed.error || parsed.error.includes("\0") || parsed.error.length > 2000) {
        if (mutating) throw applicationAccessibilityOutcomeUnknown();
        throw new Error("macOS accessibility helper returned an invalid error settlement");
      }
      const message = parsed.error;
      if (mutating && message === "application Accessibility mutation may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.") {
        throw applicationAccessibilityOutcomeUnknown();
      }
      if (message === "macOS Automation permission to control System Events is required") {
        throw new BridgeError("permission_denied", message, {
          retryable: false, details: { reason: "macos_system_events_automation_permission_required" },
        });
      }
      const boundaryError = applicationAutomationBoundaryError(message);
      if (boundaryError) throw boundaryError;
      throw new Error(message);
    }
    if (mutating && parsed.ok !== true) throw applicationAccessibilityOutcomeUnknown();
    return parsed;
  }

}

export { desktopAutomationCapabilities, powershellSingleQuotedLiteral } from "./app-automation-support.mjs";
