import { ComputerUseManager } from "../../../src/local/computer-use.mjs";
import { applicationProcessIdentityChanged } from "../../../src/local/computer-use-dispatch-settlement.mjs";

export const PNG_A_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
export const PNG_B_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=";
export const PNG_A_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

export function managerWith({
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

export function browserStub({ inspectQueue, tabUrl = null, calls = [], actError = null, actResult = null, pointActionError = null, backendNodeActionError = null, documentStateEpoch = null, documentStateHistoryEntryKey = null, documentStateViewport = null, documentStateError = null, enhanced = false, screenshotHashes = [], checkedState = null, backendToggleNoInput = false, backendTogglePreFocusNoInput = false, postDispatchWaitError = null, backendBindingConfidence = "high" }) {
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
      // Explicit hashes model capture drift independently of the valid image fixture.
      const screenshotHash = args.include_screenshot === false ? "" : (hashes.shift() || PNG_A_SHA256);
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
        imageContent: args.include_screenshot === false ? [] : [{ type: "image", data: PNG_A_BASE64, mimeType: "image/png" }],
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
      return actResult || { ok: true, tab_id: 41, url: initialUrl, title: "Example", input_mode: "trusted", trusted_input_fallback: false };
    },
  };
}

export function browserSnapshot(url, ref, epoch = `doc-${ref}`) {
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

export function browserChildFrameSnapshot({ childEpoch, ref }) {
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

export function appStub({ inspectQueue, inspectErrors = null, repeatLastInspect = false, calls = [], screenshotResult = null, screenshotResults = null, screenshotError = null, pointApplicationError = null, dragApplicationError = null, scrollApplicationError = null, operateApplicationError = null, operateApplicationResult = null, verifyApplicationValueResult = null, verifyApplicationValueError = null, windowStateResults = null, windowStateError = null, inlineWindowState = true, processIds = null, processGenerations = null, screenshotProcessId = 7001, screenshotProcessGeneration = `gen-${screenshotProcessId}`, operationProcessId = 7001, operationProcessGeneration = `gen-${operationProcessId}` }) {
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
      throw applicationProcessIdentityChanged("application process changed before operation");
    }
    if (args.expected_process_generation !== undefined && String(args.expected_process_generation) !== String(processGeneration)) {
      throw applicationProcessIdentityChanged("application process generation changed before operation");
    }
  };
  const stub = {
    visualPointCapability() {
      return {
        available: true,
        configured: true,
        probed: true,
        backend: "test",
        experimental: false,
        non_disruptive_intent: false,
        error_class: "",
      };
    },
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
        throw applicationProcessIdentityChanged("application process changed before operation");
      }
      if (args.expected_process_generation !== undefined && String(args.expected_process_generation) !== processGeneration) {
        throw applicationProcessIdentityChanged("application process generation changed before operation");
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

export function duplicateAppSnapshot(secondFocused) {
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

export function appSnapshot(frontmost, focused) {
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

export function appButtonSnapshot(name, identifier, screenBox) {
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

export function appCheckboxSnapshot(checked) {
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
