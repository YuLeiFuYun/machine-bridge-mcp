import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, opendir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createToolAuthorizer } from "./policy.mjs";
import { classifyOperationalError } from "./log.mjs";
import { BridgeError } from "./errors.mjs";
import { MACOS_UI_JXA } from "./app-automation-macos-jxa.mjs";

const MAX_APPLICATIONS = 1000;
const MAX_APPLICATION_SCAN_ENTRIES = 20_000;
const MAX_APPLICATION_SCAN_DEPTH = 3;
const MAX_UI_ELEMENTS = 500;
const MAX_UI_DEPTH = 12;
const MAX_TEXT_CHARS = 4000;
const MAX_APPLICATION_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const APP_NAME_PATTERN = /^[^\0\r\n]{1,300}$/;
const DEFAULT_APPLICATION_CACHE_MS = 30_000;
const VALUE_VERIFICATION_TTL_MS = 60_000;
const MAX_VALUE_VERIFICATION_HANDLES = 32;
const APPLICATION_KEY_PRESS_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space"]);

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
      platform: this.platform,
      discovery: true,
      open: true,
      accessibility_inspection: this.platform === "darwin",
      structured_accessibility_actions: this.platform === "darwin",
      window_screenshot: this.platform === "darwin",
      background_visual_point: this.visualPointCapability(),
      arbitrary_script_execution: false,
      permission_note: this.platform === "darwin"
        ? "UI inspection and actions require macOS Accessibility permission for the Machine Bridge runtime."
        : "Structured UI inspection currently requires macOS; application discovery and opening remain cross-platform.",
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
    if (expectedProcessId && processId !== expectedProcessId) throw new Error("application process changed before operation");
    if (expectedProcessGeneration && processGeneration !== expectedProcessGeneration) throw new Error("application process generation changed before operation");
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
    const clickCount = args.click_count === undefined ? 1 : positiveInteger(args.click_count, "click_count");
    if (clickCount > 2) throw new Error("application visual click_count must be 1 or 2");
    const expectedWindowId = positiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    this.throwIfCancelled(context);
    let captured;
    try { captured = await this.captureMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration); }
    catch (error) {
      const message = String(error?.message || error);
      if (message.includes("application process changed before operation") || message.includes("application process generation changed before operation")) throw error;
      throw new Error("application visual snapshot unavailable before dispatch");
    }
    const actualSha256 = createHash("sha256").update(captured.bytes).digest("hex");
    if (captured.window.window_id !== expectedWindowId
        || !sameWindowBoundsNode(captured.window.bounds, expectedBounds)
        || actualSha256 !== expectedScreenshotSha256) {
      throw new Error("application visual snapshot changed before dispatch");
    }
    this.throwIfCancelled(context);
    const screenX = expectedBounds.x + normalizedX * expectedBounds.width;
    const screenY = expectedBounds.y + normalizedY * expectedBounds.height;
    const localX = normalizedX * expectedBounds.width;
    const localY = normalizedY * expectedBounds.height;
    let result;
    try {
      result = await this.backgroundInputService.click({
        pid: captured.window.process_id,
        process_generation: captured.window.process_generation,
        window_id: expectedWindowId, screen_x: screenX, screen_y: screenY,
        local_x: localX, local_y: localY,
        ...(clickCount === 1 ? {} : { click_count: clickCount }),
        window_x: expectedBounds.x, window_y: expectedBounds.y,
        window_width: expectedBounds.width, window_height: expectedBounds.height,
        timeout_seconds: timeoutSeconds,
      }, context);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "cancelled") throw error;
      const message = String(error?.message || error);
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) {
        throw applicationVisualInputOutcomeUnknown(error);
      }
      if (message.includes("process_generation_changed_before_dispatch")) throw new Error("application process generation changed before operation");
      if (message.includes("before dispatch") || message.includes("unavailable")) throw new Error("application visual input unavailable before dispatch");
      throw applicationVisualInputOutcomeUnknown(error);
    }
    return {
      application, process_name: processName, ok: result?.ok === true,
      coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
      input_transport: typeof result?.input_transport === "string" ? result.input_transport : "",
      experimental_backend: true,
      focus_without_raise: result?.focus_without_raise === true,
      front_window_validated: result?.front_window_validated === true,
      cursor_preserved: result?.cursor_preserved === true,
      frontmost_restored: result?.frontmost_restored === true,
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
    const expectedWindowId = positiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    this.throwIfCancelled(context);
    let captured;
    try { captured = await this.captureMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration); }
    catch (error) {
      const message = String(error?.message || error);
      if (message.includes("application process changed before operation") || message.includes("application process generation changed before operation")) throw error;
      throw new Error("application visual snapshot unavailable before dispatch");
    }
    const actualSha256 = createHash("sha256").update(captured.bytes).digest("hex");
    if (captured.window.window_id !== expectedWindowId
        || !sameWindowBoundsNode(captured.window.bounds, expectedBounds)
        || actualSha256 !== expectedScreenshotSha256) {
      throw new Error("application visual snapshot changed before dispatch");
    }
    this.throwIfCancelled(context);
    const sourcePoint = applicationWindowPoint(expectedBounds, normalizedX, normalizedY);
    const destinationPoint = applicationWindowPoint(expectedBounds, destinationNormalizedX, destinationNormalizedY);
    let result;
    try {
      result = await this.backgroundInputService.drag({
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
    } catch (error) {
      if (error instanceof BridgeError && error.code === "cancelled") throw error;
      const message = String(error?.message || error);
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) {
        throw applicationVisualInputOutcomeUnknown(error);
      }
      if (message.includes("process_generation_changed_before_dispatch")) throw new Error("application process generation changed before operation");
      if (message.includes("before dispatch") || message.includes("unavailable")) throw new Error("application visual input unavailable before dispatch");
      throw applicationVisualInputOutcomeUnknown(error);
    }
    return {
      application, process_name: processName, ok: result?.ok === true,
      coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
      input_transport: typeof result?.input_transport === "string" ? result.input_transport : "",
      experimental_backend: true,
      focus_without_raise: result?.focus_without_raise === true,
      front_window_validated: result?.front_window_validated === true,
      cursor_preserved: result?.cursor_preserved === true,
      frontmost_restored: result?.frontmost_restored === true,
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
    const expectedWindowId = positiveInteger(args.window_id, "window_id");
    const expectedBounds = requiredWindowBounds(args.bounds);
    const expectedScreenshotSha256 = requiredSha256(args.screenshot_sha256, "screenshot_sha256");
    const expectedProcessId = optionalExpectedProcessId(args.expected_process_id);
    const expectedProcessGeneration = optionalExpectedProcessGeneration(args.expected_process_generation);
    const timeoutSeconds = clampInt(args.timeout_seconds, 30, 1, 120);
    this.throwIfCancelled(context);
    let captured;
    try { captured = await this.captureMacWindow(processName, timeoutSeconds, context, expectedProcessId, expectedProcessGeneration); }
    catch (error) {
      const message = String(error?.message || error);
      if (message.includes("application process changed before operation") || message.includes("application process generation changed before operation")) throw error;
      throw new Error("application visual snapshot unavailable before dispatch");
    }
    const actualSha256 = createHash("sha256").update(captured.bytes).digest("hex");
    if (captured.window.window_id !== expectedWindowId
        || !sameWindowBoundsNode(captured.window.bounds, expectedBounds)
        || actualSha256 !== expectedScreenshotSha256) {
      throw new Error("application visual snapshot changed before dispatch");
    }
    this.throwIfCancelled(context);
    const point = applicationWindowPoint(expectedBounds, normalizedX, normalizedY);
    let result;
    try {
      result = await this.backgroundInputService.scroll({
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
    } catch (error) {
      if (error instanceof BridgeError && error.code === "cancelled") throw error;
      const message = String(error?.message || error);
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) {
        throw applicationVisualInputOutcomeUnknown(error);
      }
      if (message.includes("process_generation_changed_before_dispatch")) throw new Error("application process generation changed before operation");
      if (message.includes("before dispatch") || message.includes("unavailable")) throw new Error("application visual input unavailable before dispatch");
      throw applicationVisualInputOutcomeUnknown(error);
    }
    return {
      application, process_name: processName, ok: result?.ok === true,
      coordinate_source: "macos_skylight_experimental", window_bound: true, screenshot_revalidated: true,
      input_transport: typeof result?.input_transport === "string" ? result.input_transport : "",
      experimental_backend: true,
      focus_without_raise: result?.focus_without_raise === true,
      front_window_validated: result?.front_window_validated === true,
      cursor_preserved: result?.cursor_preserved === true,
      frontmost_restored: result?.frontmost_restored === true,
      normalized_point: { x: normalizedX, y: normalizedY },
      scroll_delta: { delta_x: deltaX, delta_y: deltaY },
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
    if (expectedProcessId && window.process_id !== expectedProcessId) throw new Error("application process changed before operation");
    if (expectedProcessGeneration && window.process_generation !== expectedProcessGeneration) {
      throw new Error("application process generation changed before operation");
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
      const message = String(error?.message || error);
      if (message.includes("process generation changed before dispatch")) {
        throw new Error("application process generation changed before operation");
      }
      if (message.includes("outcome is unknown") || message.includes("partially dispatched")) {
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
      throw new Error(message);
    }
    if (mutating && parsed.ok !== true) throw applicationAccessibilityOutcomeUnknown();
    return parsed;
  }

}

function applicationLaunchOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application launch may have been partially dispatched; the outcome is unknown. Inspect application state before retrying.", cause);
}

function applicationAccessibilityOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application Accessibility mutation may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.", cause);
}

function applicationKeyboardOutcomeUnknown(action, cause = null) {
  const label = action === "key_press" ? "key_press" : "keystroke";
  return exposedApplicationSettlement(`application ${label} may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.`, cause);
}

function applicationVisualInputOutcomeUnknown(cause = null) {
  return exposedApplicationSettlement("application visual input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.", cause);
}

function exposedApplicationSettlement(message, cause = null) {
  const terminationRequested = cause?.details?.termination_requested === true;
  const sideEffectsStarted = cause?.details?.side_effects_started ?? "unknown";
  return new BridgeError("execution_failed", message, {
    expose: true, retryable: false, cause: cause instanceof Error ? cause : undefined,
    details: { side_effects_started: sideEffectsStarted, termination_requested: terminationRequested, effect_settlement: terminationRequested ? "pending" : "unknown" },
  });
}

async function listMacApplications(roots, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context,
    throwIfCancelled,
    match(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() === ".app"; },
    descend(entry) { return entry.isDirectory() && extname(entry.name).toLowerCase() !== ".app"; },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, ".app"), path, kind: "application-bundle" }; },
  });
}

async function listWindowsApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || [
    join(process.env.APPDATA || home, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.ProgramData ? join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs") : "",
  ].filter(Boolean);
  return listExecutableRoots(roots, new Set([".exe", ".lnk"]), context, throwIfCancelled);
}

async function listLinuxApplications(configuredRoots, home, context, throwIfCancelled) {
  const roots = configuredRoots || ["/usr/share/applications", "/usr/local/share/applications", join(home, ".local", "share", "applications")];
  return listExecutableRoots(roots, new Set([".desktop"]), context, throwIfCancelled);
}

async function listExecutableRoots(roots, extensions, context, throwIfCancelled) {
  return scanApplicationRoots(roots, {
    context,
    throwIfCancelled,
    match(entry) { return entry.isFile() && extensions.has(extname(entry.name).toLowerCase()); },
    descend(entry) { return entry.isDirectory(); },
    makeItem(path, entry) { return { id: path, name: basename(entry.name, extname(entry.name)), path, kind: "launcher" }; },
  });
}

async function scanApplicationRoots(roots, { context, throwIfCancelled, match, descend, makeItem }) {
  const results = [];
  const warnings = [];
  const seenRoots = new Set();
  let visited = 0;
  for (const inputRoot of roots) {
    let root;
    try { root = await realpath(inputRoot); } catch (error) {
      if (error?.code !== "ENOENT" && warnings.length < 50) {
        warnings.push({ path: inputRoot, error_class: classifyOperationalError(error) });
      }
      continue;
    }
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const stack = [{ directory: root, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      let handle;
      try { handle = await opendir(current.directory); } catch (error) {
        if (error?.code !== "ENOENT" && warnings.length < 50) {
          warnings.push({ path: current.directory, error_class: classifyOperationalError(error) });
        }
        continue;
      }
      for await (const entry of handle) {
        throwIfCancelled(context);
        visited += 1;
        if (visited > MAX_APPLICATION_SCAN_ENTRIES) {
          return { applications: results, warnings, truncated: true, visitedEntries: visited };
        }
        const path = join(current.directory, entry.name);
        if (match(entry)) {
          results.push(makeItem(path, entry));
          if (results.length >= MAX_APPLICATIONS) {
            return { applications: results, warnings, truncated: true, visitedEntries: visited };
          }
        } else if (current.depth < MAX_APPLICATION_SCAN_DEPTH && descend(entry)) {
          stack.push({ directory: path, depth: current.depth + 1 });
        }
      }
    }
  }
  return { applications: results, warnings, truncated: false, visitedEntries: visited };
}

function requiredApplication(value) {
  if (typeof value !== "string" || !APP_NAME_PATTERN.test(value)) {
    throw new Error("application must be a non-empty name or path without control characters");
  }
  return value;
}

function applicationProcessName(application) {
  const normalized = String(application).replace(/\\/g, "/");
  const leaf = normalized.split("/").pop() || normalized;
  return leaf.toLowerCase().endsWith(".app") ? leaf.slice(0, -4) : application;
}

function normalizeAppAction(value) {
  if (typeof value !== "string" || !["activate", "click", "check", "uncheck", "set_value", "focus", "press", "keystroke", "key_press"].includes(value)) {
    throw new Error("action must be one of activate, click, check, uncheck, set_value, focus, press, keystroke, or key_press");
  }
  return value;
}

function normalizeApplicationKeyPress(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 100) {
    throw new Error("application key_press requires a valid key");
  }
  const shifted = value.startsWith("Shift+");
  const key = shifted ? value.slice("Shift+".length) : value;
  if (!APPLICATION_KEY_PRESS_KEYS.has(key)) {
    throw new Error("application key_press supports Enter, Tab, Escape, Backspace, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown, Space, with optional Shift+");
  }
  return value;
}

function normalizeUiSelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object");
  const allowed = new Set(["role", "subrole", "name", "title", "description", "identifier", "index"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown UI selector field: ${key}`);
  const selector = {};
  for (const key of ["role", "subrole", "name", "title", "description", "identifier"]) {
    if (value[key] !== undefined) selector[key] = optionalString(value[key], `selector.${key}`, 500);
  }
  if (value.index !== undefined) selector.index = clampInt(value.index, 0, 0, MAX_UI_ELEMENTS - 1);
  if (!Object.keys(selector).length) throw new Error("selector requires at least one field");
  return selector;
}

function selectMacWindow(value) {
  const processId = requiredPositiveInteger(value?.process_id, "application process pid");
  const processGeneration = requiredProcessGeneration(value?.process_generation, "application process generation");
  const candidates = Array.isArray(value?.candidates) ? value.candidates.slice(0, 32) : [];
  const normalized = candidates.map((candidate) => {
    const windowId = candidate?.window_id;
    if (!Number.isSafeInteger(windowId) || windowId < 1) return null;
    let bounds;
    try { bounds = requiredWindowBounds(candidate?.bounds); } catch { return null; }
    return { window_id: windowId, bounds, title: typeof candidate?.title === "string" ? candidate.title.slice(0, 1000) : "" };
  }).filter(Boolean);
  if (!normalized.length) throw new Error("application has no capturable on-screen window");
  let frontBounds = null;
  try { frontBounds = requiredWindowBounds(value?.front_bounds); }
  catch { /* Invalid optional front-window bounds fall through to the explicit ambiguity checks below. */ }
  if (!frontBounds) {
    if (normalized.length === 1) return { ...normalized[0], process_id: processId, process_generation: processGeneration };
    throw new Error("application front window is ambiguous without Accessibility bounds");
  }
  const scored = normalized.map((candidate) => ({
    candidate,
    distance: windowBoundsDistanceNode(candidate.bounds, frontBounds),
  }));
  const bestDistance = Math.min(...scored.map((item) => item.distance));
  const best = scored.filter((item) => Math.abs(item.distance - bestDistance) <= 0.001).map((item) => item.candidate);
  if (best.length === 1) return { ...best[0], process_id: processId, process_generation: processGeneration };
  const frontTitle = typeof value?.front_title === "string" ? value.front_title.trim().slice(0, 1000) : "";
  if (frontTitle) {
    const titleMatches = best.filter((candidate) => candidate.title.trim() === frontTitle);
    if (titleMatches.length === 1) return { ...titleMatches[0], process_id: processId, process_generation: processGeneration };
  }
  throw new Error("application front window is ambiguous among matching on-screen windows");
}

function safeSelectedMacWindow(value) {
  try {
    const window = selectMacWindow(value);
    return {
      id: window.window_id,
      bounds: { ...window.bounds },
      process_id: window.process_id,
      process_generation: window.process_generation,
    };
  } catch {
    return null;
  }
}

function windowBoundsDistanceNode(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
    + Math.abs(left.width - right.width) + Math.abs(left.height - right.height);
}

function normalizeBackgroundVisualBackend(value) {
  if (value !== undefined && typeof value !== "string") throw new Error("backgroundVisualBackend must be disabled or skylight-experimental");
  const backend = (value || "disabled").trim().toLowerCase();
  if (!["disabled", "skylight-experimental"].includes(backend)) {
    throw new Error("backgroundVisualBackend must be disabled or skylight-experimental");
  }
  return backend;
}

function normalizedCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) throw new Error(`${label} must be from 0 (inclusive) to 1 (exclusive)`);
  return value;
}

function applicationWindowPoint(bounds, normalizedX, normalizedY) {
  return {
    screen_x: bounds.x + normalizedX * bounds.width,
    screen_y: bounds.y + normalizedY * bounds.height,
    local_x: normalizedX * bounds.width,
    local_y: normalizedY * bounds.height,
  };
}

function applicationScrollDelta(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) throw new Error(`${label} must be from -10000 to 10000`);
  return Object.is(value, -0) ? 0 : Math.round(value);
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function positiveInteger(value, label) {
  return requiredPositiveInteger(value, label);
}

function optionalExpectedProcessId(value) {
  if (value === undefined) return null;
  return requiredPositiveInteger(value, "expected_process_id");
}

function requiredProcessGeneration(value, label) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function optionalProcessGeneration(value, label) {
  if (value === undefined || value === null) return "";
  return requiredProcessGeneration(value, label);
}

function optionalExpectedProcessGeneration(value) {
  if (value === undefined) return null;
  return requiredProcessGeneration(value, "expected_process_generation");
}

function requiredWindowBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bounds must be an object");
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`bounds.${key} must be finite`);
    bounds[key] = number;
  }
  if (!(bounds.width > 0) || !(bounds.height > 0)) throw new Error("bounds width and height must be positive");
  return bounds;
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value;
}

function sameWindowBoundsNode(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const a = left[key];
    const b = right[key];
    return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && Math.abs(a - b) <= 1;
  });
}

function applicationText(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\0") || value.length > MAX_TEXT_CHARS) {
    throw new Error(`${label} exceeds ${MAX_TEXT_CHARS} characters or contains a NUL byte`);
  }
  return value;
}

function requiredResourceName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw new Error("value_resource is invalid");
  return value;
}

function requiredApplicationValueVerificationHandle(value) {
  if (typeof value !== "string" || !/^av_[A-Za-z0-9_-]{24,80}$/.test(value)) {
    throw new Error("application value verification handle is invalid");
  }
  return value;
}

function optionalString(value, label, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes`);
  return value;
}

function assertMacAccessibility(platform) {
  if (platform !== "darwin") throw new Error("structured application UI automation currently requires macOS");
}

function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function clampInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return value;
}

function isPng(value) {
  return Buffer.isBuffer(value) && value.length >= 8
    && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47
    && value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a;
}

export function powershellSingleQuotedLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
