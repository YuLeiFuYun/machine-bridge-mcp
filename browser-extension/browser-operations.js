(() => {
  if (globalThis.__machineBridgeBrowserOperations) return;

  const MAX_ACCESSIBLE_FRAMES = 64;
  const PAGE_AUTOMATION_VERSION = 4;
  const MUTATING_METHODS = new Set([
    "manage_tabs", "point_action", "backend_node_action", "action", "fill_form", "upload_files", "screenshot",
  ]);
  const MUTATION_RESULT_SETTLEMENT_UNKNOWN = "browser mutation may have completed; the action outcome is unknown because its result could not be delivered. Inspect browser state before retrying.";

  function exactFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }

  function exactPositiveFiniteNumber(value) {
    const number = exactFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  function exactNormalizedCoordinate(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1
      ? (Object.is(value, -0) ? 0 : value)
      : null;
  }

  function exactPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function exactNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function exactBoolean(value, label, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean before dispatch`);
    return value;
  }

  function exactBoundedInteger(value, label, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }

  function exactImageFormat(value, label, fallback = "png") {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !["png", "jpeg"].includes(value)) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }

  function exactOptionalSha256(value, label) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid before dispatch`);
    return value.toLowerCase();
  }

  function exactOptionalText(value, label, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }

  function requiredSnapshotAuthorityString(value, label, maxLength) {
    const text = exactOptionalAuthorityString(value, maxLength);
    if (!text) throw new Error(`${label} is required before dispatch`);
    return text;
  }

  function requiredSnapshotViewport(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("visual snapshot viewport is required before dispatch");
    const output = {};
    for (const key of ["width", "height", "scale"]) {
      const number = exactPositiveFiniteNumber(value[key]);
      if (number === null) throw new Error(`visual snapshot viewport ${key} is invalid before dispatch`);
      output[key] = number;
    }
    return output;
  }

  function exactOptionalAuthorityString(value, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
      throw new Error("snapshot authority string is invalid before dispatch");
    }
    return value;
  }

  function methodMayMutate(method) {
    return typeof method === "string" && MUTATING_METHODS.has(method);
  }

  function responsePayload({ id, ok, result, error = "", method = "", maxBytes }) {
    const mutatingSuccess = ok === true && methodMayMutate(method);
    let payload;
    try { payload = JSON.stringify({ type: "response", id, ok, ...(ok ? { result } : { error }) }); }
    catch {
      payload = JSON.stringify({ type: "response", id, ok: false,
        error: mutatingSuccess ? MUTATION_RESULT_SETTLEMENT_UNKNOWN : "browser result could not be serialized" });
    }
    const resultLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    if (resultLimit === 0 || new TextEncoder().encode(payload).byteLength > resultLimit) {
      payload = JSON.stringify({ type: "response", id, ok: false,
        error: mutatingSuccess ? MUTATION_RESULT_SETTLEMENT_UNKNOWN : "browser result exceeds maximum size" });
    }
    return payload;
  }

  async function dispatch(method, params, state) {
    if (method === "list_tabs") return listTabs(params);
    if (method === "manage_tabs") return manageTabs(params, state);
    if (method === "wait") return browserWait(params, state);
    if (method === "get_source") return getSource(params, state);
    if (method === "inspect_page") return inspectPage(params, state);
    if (method === "observe_computer") return observeComputer(params, state);
    if (method === "document_state") return documentState(params);
    if (method === "point_action") return pointAction(params, state);
    if (method === "backend_node_action") return backendNodeAction(params, state);
    if (method === "action") return browserAction(params, state);
    if (method === "fill_form") return fillForm(params, state);
    if (method === "upload_files") return uploadFiles(params, state);
    if (method === "screenshot") return screenshot(params, state);
    throw new Error(`unknown browser method: ${method}`);
  }
  
  async function listTabs(params) {
    const query = params.currentWindow ? { currentWindow: true } : {};
    const tabs = await chrome.tabs.query(query);
    return {
      tabs: tabs
        .filter((tab) => params.includePinned !== false || !tab.pinned)
        .map((tab) => ({
          id: tab.id,
          window_id: tab.windowId,
          active: tab.active,
          pinned: tab.pinned,
          audible: tab.audible,
          discarded: tab.discarded,
          status: tab.status,
          title: tab.title || "",
          url: tab.url || "",
        })),
    };
  }
  
  
  async function manageTabs(params, state) {
    const action = exactOptionalText(params?.action, "browser tab action", 32);
    if (!["new", "activate", "close"].includes(action)) throw new Error("unsupported browser tab action");
    let newTabUrl = "";
    let newTabActive = true;
    if (action === "new") {
      newTabUrl = exactOptionalText(params.url, "browser tab url", 32768);
      if (newTabUrl && !/^(https?|file):/i.test(newTabUrl)) throw new Error("browser tab url is invalid before dispatch");
      newTabActive = exactBoolean(params.active, "browser tab active", true);
    } else if (!Number.isSafeInteger(params.tabId) || params.tabId < 1) {
      throw new Error("browser tab id is invalid");
    }
    throwIfCancelled(state);
    if (action === "new") {
      const tab = await invokeBrowserTabMutation(
        () => chrome.tabs.create({ url: newTabUrl || "about:blank", active: newTabActive }),
        "create",
      );
      return { action: "new", ...publicTab(tab) };
    }
    const tab = await chrome.tabs.get(params.tabId);
    throwIfCancelled(state);
    if (action === "activate") {
      const activated = await invokeBrowserTabMutation(() => chrome.tabs.update(tab.id, { active: true }), "activate_tab");
      throwIfCancelled(state);
      if (!Number.isInteger(activated?.windowId) || activated.windowId < 1) {
        throw new Error("browser tab activation completed but its current window is unavailable before focus; inspect tabs before retrying");
      }
      let focusTarget;
      try { focusTarget = await chrome.tabs.get(tab.id); }
      catch { throw new Error("browser tab activation completed but the target tab could not be verified before focus; inspect tabs before retrying"); }
      throwIfCancelled(state);
      if (!Number.isInteger(focusTarget?.windowId) || focusTarget.windowId < 1) {
        throw new Error("browser tab activation completed but its current window is unavailable before focus; inspect tabs before retrying");
      }
      if (focusTarget.active !== true) {
        throw new Error("browser tab activation completed but the target tab was no longer active before focus; inspect tabs before retrying");
      }
      const focusWindowId = focusTarget.windowId;
      await invokeBrowserTabMutation(() => chrome.windows.update(focusWindowId, { focused: true }), "focus_window");
      let settled;
      try { settled = await chrome.tabs.get(tab.id); }
      catch { throw new Error("browser tab activation and window focus completed but the target tab could not be verified; inspect tabs before retrying"); }
      if (settled?.windowId !== focusWindowId) {
        throw new Error("browser tab activation and window focus completed but the target tab moved windows; inspect tabs before retrying");
      }
      if (settled.active !== true) {
        throw new Error("browser tab activation and window focus completed but the target tab was no longer active; inspect tabs before retrying");
      }
      return { action: "activate", ...publicTab(settled) };
    }
    const result = { action: "close", closed: true, ...publicTab(tab) };
    await invokeBrowserTabMutation(() => chrome.tabs.remove(tab.id), "close");
    return result;
  }

  function normalizeBrowserWaitParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser wait parameters are invalid");
    const timeoutMs = exactBoundedInteger(params.timeoutMs, "browser wait timeoutMs", 30000, 1, 120000);
    let frameId = params.frameId;
    if (frameId === undefined || frameId === null) frameId = null;
    else if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error("browser wait frame id is invalid");
    const selector = params.selector === undefined || params.selector === null ? null : params.selector;
    const waitState = exactOptionalText(params.state, "browser wait state", 32);
    if (waitState && !["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"].includes(waitState)) {
      throw new Error("browser wait state is invalid");
    }
    if (waitState && !selector) throw new Error("browser wait state requires selector");
    const text = exactOptionalText(params.text, "browser wait text", 4000);
    const urlContains = exactOptionalText(params.urlContains, "browser wait urlContains", 32768);
    const loadState = exactOptionalText(params.loadState, "browser wait loadState", 32);
    if (loadState && !["domcontentloaded", "complete"].includes(loadState)) throw new Error("browser wait loadState is invalid");
    if (!selector && !text && !urlContains && !loadState) throw new Error("browser wait requires a condition");
    return { tabId: params.tabId, frameId, selector, state: waitState, text, urlContains, loadState, timeoutMs };
  }

  function pageWaitPayload(params) {
    return { selector: params.selector, state: params.state, text: params.text, loadState: params.loadState };
  }

  async function browserWait(params, state) {
    params = normalizeBrowserWaitParams(params);
    const tab = await resolveTab(params.tabId);
    const timeoutMs = params.timeoutMs;
    const startedAt = performance.now();
    let last = null;
    while (performance.now() - startedAt <= timeoutMs) {
      throwIfCancelled(state);
      const current = await chrome.tabs.get(tab.id);
      const currentUrl = exactOptionalAuthorityString(current?.url, 32768);
      const urlMatched = !params.urlContains || currentUrl.includes(params.urlContains);
      const needsPage = Boolean(params.selector || params.text || params.loadState);
      let page = { matched: true, ready_state: current.status || "" };
      if (needsPage) {
        try {
          assertPageTab(current);
          const [execution] = await executePageAutomation(scriptTarget(current.id, params.frameId, false), "checkWait", pageWaitPayload(params));
          page = execution?.result || { matched: false };
        } catch (error) {
          const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
          if (message.includes("invalid CSS selector") || message.includes("selector matched")) throw new Error(message);
          page = { matched: false, error: message };
        }
      }
      last = { url_matched: urlMatched, ...page };
      if (urlMatched && page.matched === true) {
        return { ok: true, tab_id: current.id, title: current.title || "", url: current.url || "", condition: last };
      }
      await delay(200);
    }
    throw new Error(`browser wait timed out; last condition: ${JSON.stringify(last || {})}`);
  }
  function scriptTarget(tabId, frameId, allFrames) {
    if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("browser script target tab is invalid");
    if (frameId !== undefined && frameId !== null) {
      if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error("browser script target frame is invalid");
      return { tabId, frameIds: [frameId] };
    }
    if (allFrames === true) return { tabId, allFrames: true };
    if (allFrames !== undefined && allFrames !== false) throw new Error("browser script allFrames flag is invalid");
    return { tabId };
  }
  
  async function resolveTab(tabId) {
    if (tabId !== undefined && tabId !== null) {
      if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("browser tab id is invalid");
      return chrome.tabs.get(tabId);
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active browser tab");
    return tab;
  }
  
  async function getSource(params, state) {
    const maxBytes = exactBoundedInteger(params.maxBytes, "browser source maxBytes", 1024 * 1024, 1, 4 * 1024 * 1024);
    const allFrames = exactBoolean(params.allFrames, "browser source allFrames", false);
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const selection = await discoverPageFrames(tab.id, params.frameId, allFrames);
    let remainingBytes = maxBytes;
    const frames = [];
    for (let index = 0; index < selection.frames.length && remainingBytes > 0; index += 1) {
      throwIfCancelled(state);
      const remainingFrames = selection.frames.length - index;
      const frameBudget = Math.max(1, Math.floor(remainingBytes / remainingFrames));
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [selection.frames[index].frameId] },
        func: boundedDocumentSource,
        args: [frameBudget],
      });
      const result = execution?.result || { source: "", bytes: 0, returned_bytes: 0, truncated: true, url: selection.frames[index].url };
      const rawReturnedBytes = result.returned_bytes ?? result.bytes;
      const returnedBytes = Number.isSafeInteger(rawReturnedBytes) && rawReturnedBytes >= 0
        ? Math.min(frameBudget, rawReturnedBytes)
        : frameBudget;
      remainingBytes -= returnedBytes;
      frames.push({ frame_id: execution?.frameId ?? selection.frames[index].frameId, ...result, returned_bytes: returnedBytes, bytes: returnedBytes });
    }
    return {
      tab_id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      frames,
      returned_bytes: maxBytes - remainingBytes,
      max_bytes: maxBytes,
      frames_truncated: selection.truncated || frames.length < selection.frames.length,
    };
  }
  
  async function inspectPage(params, state) {
    const maxElements = exactBoundedInteger(params.maxElements, "browser inspection maxElements", 300, 1, 1000);
    const allFrames = exactBoolean(params.allFrames, "browser inspection allFrames", true);
    const includeValues = exactBoolean(params.includeValues, "browser inspection includeValues", false);
    const includePrivateHistory = exactBoolean(params.includePrivateHistory, "browser inspection includePrivateHistory", false);
    const focusQueryInput = exactOptionalText(params.focusQuery, "browser inspection focusQuery", 1000);
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const selection = await discoverPageFrames(tab.id, params.frameId, allFrames, MAX_ACCESSIBLE_FRAMES);
    const frameCount = Math.max(1, selection.frames.length);
    const probeBudget = Math.max(1, Math.min(maxElements, Math.ceil((maxElements * 2) / frameCount)));
    const probedFrames = [];
    const candidates = [];
    for (let frameIndex = 0; frameIndex < selection.frames.length; frameIndex += 1) {
      throwIfCancelled(state);
      const frame = selection.frames[frameIndex];
      const [execution] = await executePageAutomation(
        { tabId: tab.id, frameIds: [frame.frameId] },
        "inspect",
        {
          maxElements: probeBudget,
          includeValues,
          focusQuery: focusQueryInput,
          includePrivateHistory,
        },
      );
      const result = execution?.result || { elements: [], truncated: true };
      const actualFrameId = execution?.frameId ?? frame.frameId;
      const elements = Array.isArray(result.elements) ? result.elements : [];
      probedFrames.push({ frame_id: actualFrameId, ...result, elements: [] });
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        candidates.push({
          frameIndex,
          frameId: actualFrameId,
          element,
          elementIndex,
          score: typeof element?.salience_score === "number" && Number.isFinite(element.salience_score) ? element.salience_score : 0,
          topFrame: actualFrameId === 0,
        });
      }
    }
    candidates.sort((left, right) =>
      right.score - left.score
      || (right.topFrame ? 1 : 0) - (left.topFrame ? 1 : 0)
      || left.frameId - right.frameId
      || left.elementIndex - right.elementIndex);
    const selected = candidates.slice(0, maxElements);
    for (const candidate of selected) probedFrames[candidate.frameIndex].elements.push(candidate.element);
    const probeTruncated = probedFrames.some((frame) => frame.truncated === true);
    const focusQuery = focusQueryInput.trim().replace(/\s+/g, " ").toLowerCase();
    const queryMatchCount = focusQuery
      ? probedFrames.reduce((sum, frame) => {
          const count = exactNonNegativeInteger(frame.document?.focus_query_match_count);
          return sum + (count ?? 0);
        }, 0)
      : null;
    const querySearchExhaustive = focusQuery
      ? selection.truncated !== true && probedFrames.every((frame) => frame.document?.focus_query_search_exhaustive === true)
      : null;
    return {
      tab_id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      frames: probedFrames,
      total_elements: selected.length,
      max_elements: maxElements,
      frames_truncated: selection.truncated,
      selection: {
        strategy: "global_salience",
        frames_scanned: probedFrames.length,
        probed_elements: candidates.length,
        per_frame_probe_budget: probeBudget,
        candidate_truncated: probeTruncated || candidates.length > selected.length,
        focus_query: focusQuery,
        query_matched: focusQuery ? queryMatchCount > 0 : null,
        query_match_count: queryMatchCount,
        query_search_exhaustive: querySearchExhaustive,
      },
    };
  }

  async function documentState(params) {
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const [execution] = await executePageAutomation({ tabId: tab.id, frameIds: [0] }, "documentState", {});
    const state = execution?.result || {};
    return {
      tab_id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      document_epoch: exactOptionalAuthorityString(state.epoch, 9000),
      document_url: exactOptionalAuthorityString(state.url, 8192),
      _machine_history_entry_key: exactOptionalAuthorityString(state._machine_history_entry_key, 512),
      ready_state: String(state.ready_state || ""),
      viewport: state.viewport && typeof state.viewport === "object" ? state.viewport : null,
    };
  }

  async function pointAction(params, state) {
    const tabId = exactPositiveInteger(params.tabId);
    if (tabId === null) throw new Error("visual snapshot tab id is required before dispatch");
    const expectedDocumentEpoch = requiredSnapshotAuthorityString(params.expectedDocumentEpoch, "visual snapshot document epoch", 9000);
    const expectedViewport = requiredSnapshotViewport(params.expectedViewport);
    const expectedScreenshotSha256 = exactOptionalSha256(params.expectedScreenshotSha256, "visual snapshot digest");
    if (!expectedScreenshotSha256) throw new Error("visual snapshot digest is required before dispatch");
    const visualSnapshot = {
      expectedScreenshotSha256,
      screenshotFormat: exactImageFormat(params.screenshotFormat, "visual snapshot format"),
      screenshotQuality: exactBoundedInteger(params.screenshotQuality, "visual snapshot quality", 90, 1, 100),
    };
    throwIfCancelled(state);
    const tab = await resolveTab(tabId);
    assertPageTab(tab);
    const action = exactOptionalAuthorityString(params.action, 32);
    if (!["click", "double_click", "hover", "drag", "scroll"].includes(action)) throw new Error("visual point action must be click, double_click, hover, drag, or scroll");
    const scrollDeltas = action === "scroll" ? normalizeScrollDeltas(params) : null;
    const normalizedX = exactNormalizedCoordinate(params.normalizedX);
    const normalizedY = exactNormalizedCoordinate(params.normalizedY);
    if (normalizedX === null || normalizedY === null) {
      throw new Error("visual point must use normalized viewport coordinates from 0 (inclusive) to 1 (exclusive)");
    }
    const currentState = await documentState({ tabId: tab.id });
    if (currentState.document_epoch !== expectedDocumentEpoch) {
      throw new Error("computer visual snapshot is stale because the document was replaced");
    }
    const viewport = currentState.viewport || {};
    const width = exactPositiveFiniteNumber(viewport.width);
    const height = exactPositiveFiniteNumber(viewport.height);
    const scale = exactPositiveFiniteNumber(viewport.scale);
    const offsetLeft = exactFiniteNumber(viewport.offset_left);
    const offsetTop = exactFiniteNumber(viewport.offset_top);
    if (width === null || height === null || scale === null || offsetLeft === null || offsetTop === null) {
      throw new Error("browser viewport dimensions are unavailable for visual point action");
    }
    if (Math.abs(scale - 1) > 0.001 || Math.abs(offsetLeft) > 0.5 || Math.abs(offsetTop) > 0.5) {
      throw new Error("visual point action is unavailable while the visual viewport is zoomed or offset");
    }
    if (expectedViewport && !sameViewport(expectedViewport, viewport)) {
      throw new Error("computer visual snapshot is stale because the viewport changed");
    }
    const point = { x: normalizedX * width, y: normalizedY * height };
    const [probe] = await executePageAutomation({ tabId: tab.id, frameIds: [0] }, "pointProbe", point);
    let destinationPoint = null;
    let destinationProbe = null;
    if (action === "drag") {
      const destinationNormalizedX = exactNormalizedCoordinate(params.destinationNormalizedX);
      const destinationNormalizedY = exactNormalizedCoordinate(params.destinationNormalizedY);
      if (destinationNormalizedX === null || destinationNormalizedY === null) {
        throw new Error("visual drag destination must use normalized viewport coordinates from 0 (inclusive) to 1 (exclusive)");
      }
      destinationPoint = { x: destinationNormalizedX * width, y: destinationNormalizedY * height };
      [destinationProbe] = await executePageAutomation({ tabId: tab.id, frameIds: [0] }, "pointProbe", destinationPoint);
    }
    throwIfCancelled(state);
    try {
      const api = globalThis.__machineBridgeDevtoolsInput;
      if (!api?.perform) throw trustedUnavailableError();
      await api.perform(tab.id, action, {
        point,
        ...(destinationPoint ? { destinationPoint } : {}),
        ...(scrollDeltas || {}),
        ...(visualSnapshot || {}),
        beforeDispatch: () => throwIfCancelledBeforeTrustedInput(state),
      });
    } catch (error) {
      if (error?.machineBridgeBeforeDispatchAbort === true) throw error;
      if (error?.safeToFallback === true) throw error;
      const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (${detail})`);
    }
    const current = await postActionTabMetadata(tab.id);
    return {
      ok: true,
      input_mode: "trusted",
      trusted_input_fallback: false,
      ...current,
      point: { normalized_x: normalizedX, normalized_y: normalizedY, css_x: point.x, css_y: point.y },
      ...(scrollDeltas ? { scroll_delta: { delta_x: scrollDeltas.deltaX, delta_y: scrollDeltas.deltaY } } : {}),
      ...(destinationPoint ? { destination_point: {
        normalized_x: params.destinationNormalizedX, normalized_y: params.destinationNormalizedY,
        css_x: destinationPoint.x, css_y: destinationPoint.y,
      } } : {}),
      hit: probe?.result?.hit || null,
      ...(destinationPoint ? { destination_hit: destinationProbe?.result?.hit || null } : {}),
    };
  }

  async function backendNodeAction(params, state) {
    const tabId = exactPositiveInteger(params.tabId);
    if (tabId === null) throw new Error("snapshot backend tab id is required before dispatch");
    const expectedDocumentEpoch = requiredSnapshotAuthorityString(params.expectedDocumentEpoch, "snapshot backend document epoch", 9000);
    throwIfCancelled(state);
    const tab = await resolveTab(tabId);
    assertPageTab(tab);
    const action = exactOptionalAuthorityString(params.action, 32);
    const pointerActions = new Set(["click", "double_click", "hover", "drag", "scroll"]);
    const focusActions = new Set(["press", "type_text", "fill", "check", "uncheck", "submit"]);
    if (!pointerActions.has(action) && !focusActions.has(action)) {
      throw new Error("snapshot backend action must be click, double_click, hover, drag, scroll, press, type_text, fill, check, uncheck, or submit");
    }
    const backendNodeId = exactPositiveInteger(params.backendNodeId);
    if (backendNodeId === null) throw new Error("snapshot backend action requires a valid backend node");
    const destinationBackendNodeId = action === "drag" ? exactPositiveInteger(params.destinationBackendNodeId) : null;
    if (action === "drag" && destinationBackendNodeId === null) {
      throw new Error("snapshot backend drag requires a valid destination backend node");
    }
    const scrollDeltas = action === "scroll" ? normalizeScrollDeltas(params) : null;
    const currentState = await documentState({ tabId: tab.id });
    if (currentState.document_epoch !== expectedDocumentEpoch) {
      throw new Error("snapshot_backend_target_changed_before_dispatch");
    }
    if (params.expectedFrameDocumentEpoch) {
      const extensionFrameId = exactNonNegativeInteger(params.extensionFrameId);
      let frameState = null;
      if (extensionFrameId === 0) {
        frameState = { epoch: currentState.document_epoch, url: currentState.document_url };
      } else if (Number.isInteger(extensionFrameId) && extensionFrameId > 0) {
        try {
          const [execution] = await executePageAutomation({ tabId: tab.id, frameIds: [extensionFrameId] }, "documentState", {});
          frameState = execution?.result || null;
        } catch {}
      }
      if (!frameState
          || exactOptionalAuthorityString(frameState.epoch, 9000) !== exactOptionalAuthorityString(params.expectedFrameDocumentEpoch, 9000)
          || (params.expectedFrameUrl && exactOptionalAuthorityString(frameState.url, 8192) !== exactOptionalAuthorityString(params.expectedFrameUrl, 8192))) {
        throw new Error("snapshot_backend_target_changed_before_dispatch");
      }
    }
    if (params.extensionRef && params.expectedIdentity) {
      const extensionFrameId = exactNonNegativeInteger(params.extensionFrameId);
      let identityMatched = false;
      if (Number.isInteger(extensionFrameId) && extensionFrameId >= 0) {
        try {
          const [execution] = await executePageAutomation({ tabId: tab.id, frameIds: [extensionFrameId] }, "refIdentity", {
            ref: params.extensionRef,
            expectedIdentity: params.expectedIdentity,
          });
          identityMatched = execution?.result?.attached === true && execution?.result?.matched === true;
        } catch {}
      }
      if (!identityMatched) throw new Error("snapshot_backend_target_changed_before_dispatch");
    }
    if (action === "drag") {
      if (params.destinationExpectedFrameDocumentEpoch) {
        const destinationExtensionFrameId = exactNonNegativeInteger(params.destinationExtensionFrameId);
        let frameState = null;
        if (destinationExtensionFrameId === 0) {
          frameState = { epoch: currentState.document_epoch, url: currentState.document_url };
        } else if (Number.isInteger(destinationExtensionFrameId) && destinationExtensionFrameId > 0) {
          try {
            const [execution] = await executePageAutomation({ tabId: tab.id, frameIds: [destinationExtensionFrameId] }, "documentState", {});
            frameState = execution?.result || null;
          } catch {}
        }
        if (!frameState
            || exactOptionalAuthorityString(frameState.epoch, 9000) !== exactOptionalAuthorityString(params.destinationExpectedFrameDocumentEpoch, 9000)
            || (params.destinationExpectedFrameUrl && exactOptionalAuthorityString(frameState.url, 8192) !== exactOptionalAuthorityString(params.destinationExpectedFrameUrl, 8192))) {
          throw new Error("snapshot_backend_target_changed_before_dispatch");
        }
      }
      if (params.destinationExtensionRef && params.destinationExpectedIdentity) {
        const destinationExtensionFrameId = exactNonNegativeInteger(params.destinationExtensionFrameId);
        let identityMatched = false;
        if (Number.isInteger(destinationExtensionFrameId) && destinationExtensionFrameId >= 0) {
          try {
            const [execution] = await executePageAutomation({ tabId: tab.id, frameIds: [destinationExtensionFrameId] }, "refIdentity", {
              ref: params.destinationExtensionRef,
              expectedIdentity: params.destinationExpectedIdentity,
            });
            identityMatched = execution?.result?.attached === true && execution?.result?.matched === true;
          } catch {}
        }
        if (!identityMatched) throw new Error("snapshot_backend_target_changed_before_dispatch");
      }
    }
    const session = globalThis.__machineBridgeDevtoolsSession;
    const input = globalThis.__machineBridgeDevtoolsInput;
    if (!session?.run || !input?.performWithSend) throw new Error("snapshot_backend_trusted_input_unavailable_before_dispatch");
    let focusApplied = false;
    let scrollApplied = false;
    try {
      const result = await session.run(tab.id, async ({ send }) => {
        throwIfCancelled(state);
        if (action === "check" || action === "uncheck") {
          const desired = action === "check";
          const checked = await backendNodeCheckedState(send, backendNodeId);
          throwIfCancelled(state);
          if (checked === desired) {
            return { point: null, coordinateSource: "cdp_ax_state_noop", noInputRequired: true };
          }
        }
        if (focusActions.has(action)) {
          await focusBackendNode(send, backendNodeId);
          focusApplied = true;
          throwIfCancelled(state);
          const focusResult = await performBackendFocusAction(input, send, action, params, backendNodeId, state);
          return { point: null, coordinateSource: "cdp_dom_focus", ...focusResult };
        }
        if (action === "drag") {
          const sourceGeometry = await backendNodeViewportGeometry(send, backendNodeId);
          throwIfCancelled(state);
          const destinationGeometry = await backendNodeViewportGeometry(send, destinationBackendNodeId);
          throwIfCancelled(state);
          if (!sourceGeometry.insideViewport || !destinationGeometry.insideViewport) {
            throw new Error("snapshot_backend_drag_geometry_unavailable_before_dispatch");
          }
          await input.performWithSend(send, "drag", {
            point: sourceGeometry.point,
            destinationPoint: destinationGeometry.point,
          });
          return {
            point: sourceGeometry.point,
            destinationPoint: destinationGeometry.point,
            coordinateSource: "cdp_content_quad",
          };
        }
        if (action === "scroll") {
          const geometry = await backendNodeViewportGeometry(send, backendNodeId);
          throwIfCancelled(state);
          if (!geometry.insideViewport) throw new Error("snapshot_backend_scroll_geometry_unavailable_before_dispatch");
          await input.performWithSend(send, "scroll", {
            point: geometry.point,
            deltaX: scrollDeltas.deltaX,
            deltaY: scrollDeltas.deltaY,
          });
          return {
            point: geometry.point,
            scrollDelta: scrollDeltas,
            coordinateSource: "cdp_content_quad",
          };
        }
        let geometry = await backendNodeViewportGeometry(send, backendNodeId);
        throwIfCancelled(state);
        if (!geometry.insideViewport) {
          await scrollBackendNodeIntoView(send, backendNodeId);
          scrollApplied = true;
          throwIfCancelled(state);
          geometry = await backendNodeViewportGeometry(send, backendNodeId);
          if (!geometry.insideViewport) throw new Error("snapshot_backend_geometry_unavailable_before_dispatch");
        }
        const point = geometry.point;
        throwIfCancelled(state);
        await input.performWithSend(send, action, { point });
        return { point, coordinateSource: "cdp_content_quad" };
      }, { beforeAttach: () => throwIfCancelledBeforeTrustedInput(state) });
      const current = await postActionTabMetadata(tab.id);
      return {
        ok: true,
        input_mode: "trusted",
        trusted_input_fallback: false,
        coordinate_source: result.coordinateSource,
        cross_frame_trusted: exactNonNegativeInteger(params.extensionFrameId) > 0,
        ...current,
        no_input_required: result.noInputRequired === true,
        ...(result.point ? { point: result.point } : {}),
        ...(result.destinationPoint ? { destination_point: result.destinationPoint } : {}),
        ...(result.scrollDelta ? { scroll_delta: {
          delta_x: result.scrollDelta.deltaX, delta_y: result.scrollDelta.deltaY,
        } } : {}),
      };
    } catch (error) {
      if (error?.machineBridgeFocusOutcomeUnknown === true
          || error?.machineBridgeScrollOutcomeUnknown === true
          || focusApplied
          || scrollApplied) {
        const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (${detail})`);
      }
      if (error?.machineBridgeTrustedInput === true) {
        if (error.safeToFallback === true) throw new Error("snapshot_backend_trusted_input_unavailable_before_dispatch");
        const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (${detail})`);
      }
      throw error;
    }
  }

  async function scrollBackendNodeIntoView(send, backendNodeId) {
    try { await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }); } catch (error) {
      if (backendTargetChanged(error)) throw new Error("snapshot_backend_target_changed_before_dispatch");
      const failure = new Error("snapshot_backend_scroll_outcome_unknown");
      Object.defineProperty(failure, "machineBridgeScrollOutcomeUnknown", { value: true });
      throw failure;
    }
  }

  async function focusBackendNode(send, backendNodeId) {
    try { await send("DOM.focus", { backendNodeId }); } catch (error) {
      if (backendTargetChanged(error)) throw new Error("snapshot_backend_target_changed_before_dispatch");
      const failure = new Error("snapshot_backend_focus_outcome_unknown");
      Object.defineProperty(failure, "machineBridgeFocusOutcomeUnknown", { value: true });
      throw failure;
    }
  }

  async function backendNodeViewportGeometry(send, backendNodeId) {
    let quads;
    try {
      quads = (await send("DOM.getContentQuads", { backendNodeId }))?.quads;
    } catch (error) {
      if (backendTargetChanged(error)) throw new Error("snapshot_backend_target_changed_before_dispatch");
      throw new Error("snapshot_backend_geometry_unavailable_before_dispatch");
    }
    const point = pointFromContentQuads(quads);
    if (!point) throw new Error("snapshot_backend_geometry_unavailable_before_dispatch");
    let metrics;
    try { metrics = await send("Page.getLayoutMetrics"); }
    catch { throw new Error("snapshot_backend_geometry_unavailable_before_dispatch"); }
    const insideViewport = pointInsideViewport(point, metrics);
    if (insideViewport === null) throw new Error("snapshot_backend_geometry_unavailable_before_dispatch");
    return { point, insideViewport };
  }

  async function performBackendFocusAction(input, send, action, params, backendNodeId, state) {
    if (action === "press") {
      await input.performWithSend(send, "press", { key: boundedBackendKey(params.key) || "Enter" });
      return {};
    }
    if (action === "check" || action === "uncheck") {
      const desired = action === "check";
      const checked = await backendNodeCheckedState(send, backendNodeId);
      throwIfCancelled(state);
      if (checked === desired) return { noInputRequired: true };
      await input.performWithSend(send, "press", { key: "Space" });
      return { noInputRequired: false };
    }
    if (action === "submit") {
      await input.performWithSend(send, "press", { key: "Enter" });
      return {};
    }
    const text = boundedBackendText(params.value);
    if (action === "type_text") {
      await input.performWithSend(send, "type_text", { text });
      return {};
    }
    if (action === "fill") {
      await input.performWithSend(send, "fill_text", { text, selectAllKey: selectAllShortcut() });
      return {};
    }
    throw new Error("unsupported snapshot backend focus action");
  }

  async function backendNodeCheckedState(send, backendNodeId) {
    let nodes;
    try {
      nodes = (await send("Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      }))?.nodes;
    } catch (error) {
      if (backendTargetChanged(error)) throw new Error("snapshot_backend_target_changed_before_dispatch");
      throw new Error("snapshot_backend_checked_state_unavailable_before_dispatch");
    }
    const candidates = Array.isArray(nodes) ? nodes : [];
    const node = candidates.find((item) => Number.isSafeInteger(item?.backendDOMNodeId) && item.backendDOMNodeId === backendNodeId) || null;
    const property = Array.isArray(node?.properties)
      ? node.properties.find((item) => item?.name === "checked")
      : null;
    const value = property?.value?.value;
    if (value === true || value === 1 || value === "true") return true;
    if (value === false || value === 0 || value === "false") return false;
    throw new Error("snapshot_backend_checked_state_unavailable_before_dispatch");
  }

  function boundedBackendText(value) {
    if (typeof value !== "string") throw new Error("snapshot backend text action requires value");
    if (value.includes("\0") || value.length > 128 * 1024) throw new Error("snapshot backend text value exceeds the maximum length or contains a NUL byte");
    return value;
  }

  function boundedBackendKey(value) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.includes("\0") || value.length > 100) throw new Error("snapshot backend key is invalid");
    return value;
  }

  function selectAllShortcut() {
    const platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "").toLowerCase();
    return platform.includes("mac") ? "Meta+A" : "Control+A";
  }

  function pointFromContentQuads(quads) {
    let best = null;
    let bestArea = 0;
    for (const quad of Array.isArray(quads) ? quads : []) {
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
      const points = [];
      for (let index = 0; index < 8; index += 2) points.push({ x: quad[index], y: quad[index + 1] });
      let twiceArea = 0;
      for (let index = 0; index < points.length; index += 1) {
        const next = points[(index + 1) % points.length];
        twiceArea += points[index].x * next.y - next.x * points[index].y;
      }
      const area = Math.abs(twiceArea) / 2;
      if (area <= bestArea) continue;
      bestArea = area;
      best = {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    }
    return bestArea > 0 ? best : null;
  }

  function pointInsideViewport(point, metrics) {
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || {};
    const width = exactPositiveFiniteNumber(viewport.clientWidth ?? viewport.width);
    const height = exactPositiveFiniteNumber(viewport.clientHeight ?? viewport.height);
    if (width === null || height === null) return null;
    return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
  }

  function backendTargetChanged(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return /(?:node|backend).*(?:not found|does not exist|detached)/.test(message)
      || /(?:not found|does not exist|detached|could not find|no such|no)\s+.*(?:node|backend)/.test(message)
      || /could not find.*(?:node|backend)/.test(message);
  }

  function normalizeScrollDeltas(params) {
    const deltaX = normalizeScrollDelta(params.deltaX, "deltaX");
    const deltaY = normalizeScrollDelta(params.deltaY, "deltaY");
    if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero delta");
    return { deltaX, deltaY };
  }

  function normalizeScrollDelta(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
      throw new Error(`${label} must be a finite number from -10000 to 10000`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  function sameViewport(expected, current) {
    for (const key of ["width", "height", "scale"]) {
      const left = expected?.[key];
      const right = current?.[key];
      if (typeof left !== "number" || typeof right !== "number"
          || !Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > 0.5) return false;
    }
    return true;
  }

  function trustedUnavailableError() {
    const error = new Error("trusted input module is unavailable");
    Object.defineProperty(error, "safeToFallback", { value: true });
    return error;
  }

  async function observeComputer(params, state) {
    const normalized = normalizeComputerObservationParams(params);
    let last = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      throwIfCancelled(state);
      last = await captureComputerAttempt(normalized, state);
      if (last.capture.navigation_coherent === true) return last;
    }
    throw new Error("page changed during computer observation; observe again");
  }

  function normalizeComputerObservationParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("computer observation parameters are invalid");
    return {
      tabId: params.tabId,
      allFrames: exactBoolean(params.allFrames, "computer observation allFrames", true),
      maxElements: exactBoundedInteger(params.maxElements, "computer observation maxElements", 300, 1, 1000),
      maxAxNodes: exactBoundedInteger(params.maxAxNodes, "computer observation maxAxNodes", 600, 1, 2000),
      maxFrames: exactBoundedInteger(params.maxFrames, "computer observation maxFrames", 32, 1, MAX_ACCESSIBLE_FRAMES),
      axDepth: exactBoundedInteger(params.axDepth, "computer observation axDepth", 12, 1, 16),
      includeValues: exactBoolean(params.includeValues, "computer observation includeValues", false),
      includeScreenshot: exactBoolean(params.includeScreenshot, "computer observation includeScreenshot", true),
      format: exactImageFormat(params.format, "computer observation format"),
      quality: exactBoundedInteger(params.quality, "computer observation quality", 90, 1, 100),
      focusQuery: exactOptionalText(params.focusQuery, "computer observation focusQuery", 1000),
    };
  }

  async function captureComputerAttempt(params, state) {
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const inspected = await inspectPage({
      tabId: tab.id,
      allFrames: params.allFrames,
      maxElements: params.maxElements,
      includeValues: params.includeValues === true,
      focusQuery: params.focusQuery || "",
      includePrivateHistory: true,
    }, state);
    const topFrame = inspected.frames.find((frame) => frame.frame_id === 0) || inspected.frames[0] || null;
    const semanticEpoch = exactOptionalAuthorityString(topFrame?.document?.epoch, 9000);
    let cdp = null;
    let fallbackReason = "";
    try {
      const api = globalThis.__machineBridgeDevtoolsObservation;
      if (!api?.capture) throw new Error("CDP observation module unavailable");
      cdp = await api.capture(tab.id, {
        maxNodes: params.maxAxNodes,
        maxFrames: params.maxFrames,
        depth: params.axDepth,
        includeValues: params.includeValues === true,
        includeScreenshot: params.includeScreenshot,
        format: params.format,
        quality: params.quality,
        focusQuery: params.focusQuery || "",
      }, state);
    } catch (error) {
      if (requestCancelled(error)) throw error;
      fallbackReason = "cdp_observation_unavailable";
    }

    let fallbackScreenshot = null;
    let screenshotFallbackReason = "";
    if (params.includeScreenshot && !cdp?.screenshot?.data) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
      if (activeTab?.id === tab.id) {
        try {
          fallbackScreenshot = await screenshot({
            tabId: tab.id,
            format: params.format,
            quality: params.quality,
            allowTabSwitch: false,
          });
        } catch (error) {
          if (requestCancelled(error)) throw error;
          screenshotFallbackReason = "visible_tab_fallback_unavailable";
        }
      } else {
        screenshotFallbackReason = activeTab?.id
          ? "visible_tab_fallback_skipped_inactive_target"
          : "visible_tab_fallback_skipped_active_tab_unknown";
      }
    }

    throwIfCancelled(state);
    const postFrameStates = await browserFrameDocumentStates(tab.id, inspected.frames).catch(() => new Map());
    throwIfCancelled(state);
    const postState = postFrameStates.get(0) || null;
    let current;
    try { current = await chrome.tabs.get(tab.id); }
    catch { throw new Error("browser tab became unavailable during computer observation"); }
    throwIfCancelled(state);
    const semanticFramesCoherent = browserSemanticFramesCoherent(inspected.frames, postFrameStates);
    const semanticCoherent = Boolean(semanticEpoch && semanticFramesCoherent);
    const cdpRootUrl = exactOptionalAuthorityString(cdp?.frame_tree?.[0]?.url, 8192);
    const postUrl = exactOptionalAuthorityString(postState?.url, 8192);
    const currentUrl = exactOptionalAuthorityString(current?.url, 32768);
    const cdpCoherent = !cdp || (cdp.navigation_coherent === true && (!cdpRootUrl || (postUrl && cdpRootUrl === postUrl)));
    const navigationCoherent = Boolean(semanticCoherent && cdpCoherent && currentUrl && postUrl && currentUrl === postUrl);

    if (cdp?.accessibility?.nodes) fuseAccessibilityRefs(inspected.frames, cdp);
    const screenshotResult = typeof cdp?.screenshot?.data === "string" && cdp.screenshot.data
      ? {
          mime_type: cdp.screenshot.mime_type,
          data: `data:${cdp.screenshot.mime_type};base64,${cdp.screenshot.data}`,
          source: "cdp_surface",
        }
      : typeof fallbackScreenshot?.data === "string" && fallbackScreenshot.data
        ? {
            mime_type: fallbackScreenshot.data.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png",
            data: fallbackScreenshot.data,
            source: "capture_visible_tab_fallback",
          }
        : null;
    return {
      tab_id: current.id,
      title: current.title || "",
      url: current.url || "",
      semantic: inspected,
      accessibility: cdp?.accessibility || null,
      viewport: cdp?.viewport || null,
      frame_tree: cdp?.frame_tree || [],
      document_epoch: exactOptionalAuthorityString(cdp?.document_epoch, 9000) || semanticEpoch,
      _machine_history_entry_key: exactOptionalAuthorityString(postState?._machine_history_entry_key, 512),
      capture: {
        atomic: false,
        navigation_coherent: navigationCoherent,
        frame_epochs_coherent: semanticFramesCoherent,
        semantic_epoch: semanticEpoch,
        cdp_epoch: exactOptionalAuthorityString(cdp?.document_epoch, 9000),
        cdp: Boolean(cdp),
        cdp_components: cdp?.components || null,
        screenshot_source: screenshotResult?.source || "none",
        screenshot_format: screenshotResult?.mime_type === "image/jpeg" ? "jpeg" : screenshotResult ? "png" : "",
        screenshot_quality: params.format === "jpeg" ? params.quality : null,
        coherence: cdp
          ? "single_cdp_session_plus_stable_extension_document_epoch"
          : fallbackScreenshot?.data
            ? "stable_extension_document_epoch_with_visible_tab_screenshot_fallback"
            : "stable_extension_document_epoch_without_screenshot",
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        ...(screenshotFallbackReason ? { screenshot_fallback_reason: screenshotFallbackReason } : {}),
      },
      screenshot: screenshotResult,
    };
  }

  async function browserFrameDocumentStates(tabId, frames) {
    const frameIds = [...new Set((Array.isArray(frames) ? frames : [])
      .map((frame) => exactNonNegativeInteger(frame?.frame_id))
      .filter((frameId) => frameId !== null))].slice(0, MAX_ACCESSIBLE_FRAMES);
    if (!frameIds.length) return new Map();
    const executions = await executePageAutomation({ tabId, frameIds }, "documentState", {});
    const states = new Map();
    for (const execution of executions || []) {
      if (!Number.isInteger(execution?.frameId)) continue;
      const state = execution?.result;
      if (!state || typeof state !== "object") continue;
      states.set(execution.frameId, state);
    }
    return states;
  }

  function browserSemanticFramesCoherent(frames, postStates) {
    const observed = Array.isArray(frames) ? frames : [];
    if (!observed.length || !(postStates instanceof Map)) return false;
    return observed.every((frame) => {
      const frameId = exactNonNegativeInteger(frame?.frame_id);
      const before = frame?.document || {};
      const after = frameId === null ? null : postStates.get(frameId);
      const epoch = exactOptionalAuthorityString(before.epoch, 9000);
      const url = exactOptionalAuthorityString(before.url, 8192);
      const historyEntryKey = exactOptionalAuthorityString(before._machine_history_entry_key, 512);
      return frameId !== null
        && Boolean(epoch)
        && Boolean(after)
        && exactOptionalAuthorityString(after.epoch, 9000) === epoch
        && exactOptionalAuthorityString(after.url, 8192) === url
        && exactOptionalAuthorityString(after._machine_history_entry_key, 512) === historyEntryKey;
    });
  }

  function fuseAccessibilityRefs(frames, cdp) {
    const cdpFrameUrls = new Map();
    for (const frame of Array.isArray(cdp.frame_tree) ? cdp.frame_tree : []) {
      const frameId = exactOptionalAuthorityString(frame?.id, 32768);
      const frameUrl = exactOptionalAuthorityString(frame?.url, 8192);
      if (frameId && frameUrl) cdpFrameUrls.set(frameId, frameUrl);
    }
    const frameCandidates = new Map();
    for (const frame of frames || []) {
      const url = exactOptionalAuthorityString(frame?.document?.url, 8192);
      if (!url) continue;
      const list = frameCandidates.get(url) || [];
      list.push(frame);
      frameCandidates.set(url, list);
    }
    const usedRefs = new Set();
    for (const node of cdp.accessibility?.nodes || []) {
      if (!Number.isSafeInteger(node?.backend_dom_node_id) || node.backend_dom_node_id <= 0) continue;
      const nodeFrameId = exactOptionalAuthorityString(node.frame_id, 32768);
      if (!nodeFrameId) continue;
      const frameUrl = cdpFrameUrls.get(nodeFrameId) || "";
      const matchingFrames = frameCandidates.get(frameUrl) || [];
      if (matchingFrames.length !== 1) continue;
      const candidates = [];
      for (const element of Array.isArray(matchingFrames[0].elements) ? matchingFrames[0].elements : []) {
        if (typeof element?.ref !== "string" || !element.ref || element.ref.length > 100 || usedRefs.has(element.ref)) continue;
        const evidence = accessibilityMatchEvidence(node, element);
        if (evidence.score > 0) candidates.push({ element, ...evidence });
      }
      candidates.sort((left, right) => right.score - left.score);
      if (!candidates.length || candidates[0].score < 100) continue;
      if (candidates[1] && candidates[0].score - candidates[1].score < 15) continue;
      node.action_ref = candidates[0].element.ref;
      const confidence = candidates[0].score >= 180 && candidates[0].executable === true ? "high" : "medium";
      node.action_ref_confidence = confidence;
      if (confidence === "high" && Number.isSafeInteger(node.backend_dom_node_id) && node.backend_dom_node_id > 0) {
        candidates[0].element._machine_backend_node_id = node.backend_dom_node_id;
      }
      usedRefs.add(candidates[0].element.ref);
    }
  }

  function accessibilityMatchEvidence(node, element) {
    let score = 0;
    const roleA = normalizedIdentity(node.role);
    const roleB = normalizedIdentity(element.role);
    const nameA = normalizedIdentity(node.name);
    const nameB = normalizedIdentity(element.name) || normalizedIdentity(element.label) || normalizedIdentity(element.placeholder);
    const roleExact = Boolean(roleA && roleB && roleA === roleB);
    const roleConflict = Boolean(roleA && roleB && roleA !== roleB);
    const nameExact = Boolean(nameA && nameB && nameA === nameB);
    const nameConflict = Boolean(nameA && nameB && nameA !== nameB);
    if (roleExact) score += 50;
    else if (roleConflict) score -= 30;
    if (nameExact) score += 60;
    else if (nameConflict) score -= 40;
    const geometry = boundingSimilarity(node.bounding_box, element.bounding_box);
    score += geometry.score;
    if (node.clickable === true && element.visible === true && element.enabled === true) score += 15;
    return {
      score,
      executable: geometry.strong === true
        && !roleConflict
        && !nameConflict
        && (roleExact || nameExact),
    };
  }

  function boundingSimilarity(left, right) {
    if (!left || typeof left !== "object" || Array.isArray(left)
        || !right || typeof right !== "object" || Array.isArray(right)) return { score: 0, strong: false };
    const values = [left.x, left.y, left.width, left.height, right.x, right.y, right.width, right.height];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return { score: 0, strong: false };
    const [ax1, ay1, aw, ah, bx1, by1, bw, bh] = values;
    if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) {
      return { score: 0, strong: false };
    }
    const ax2 = ax1 + aw; const ay2 = ay1 + ah; const bx2 = bx1 + bw; const by2 = by1 + bh;
    const intersection = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) * Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const union = aw * ah + bw * bh - intersection;
    const iou = union > 0 ? intersection / union : 0;
    if (iou >= 0.9) return { score: 120, strong: true };
    if (iou >= 0.7) return { score: 100, strong: true };
    if (iou >= 0.5) return { score: 75, strong: false };
    const acx = ax1 + aw / 2; const acy = ay1 + ah / 2; const bcx = bx1 + bw / 2; const bcy = by1 + bh / 2;
    const distance = Math.hypot(acx - bcx, acy - bcy);
    if (distance <= 2) return { score: 55, strong: false };
    if (distance <= 5) return { score: 35, strong: false };
    return { score: 0, strong: false };
  }

  function normalizedIdentity(value) {
    if (typeof value !== "string" || value.length > 4000 || value.includes("\0")) return "";
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  async function discoverPageFrames(tabId, frameId, allFrames, resultBudget = MAX_ACCESSIBLE_FRAMES) {
    if (Number.isInteger(frameId)) return { frames: [{ frameId, url: "" }], truncated: false };
    if (!allFrames) return { frames: [{ frameId: 0, url: "" }], truncated: false };
    const executions = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ url: String(location.href || "").slice(0, 8192) }),
    });
    const ordered = executions
      .filter((item) => Number.isInteger(item.frameId))
      .map((item) => ({ frameId: item.frameId, url: item.result?.url || "" }))
      .sort((left, right) => (left.frameId === 0 ? -1 : right.frameId === 0 ? 1 : left.frameId - right.frameId));
    const limit = Number.isSafeInteger(resultBudget) && resultBudget > 0
      ? Math.min(MAX_ACCESSIBLE_FRAMES, resultBudget)
      : 1;
    return { frames: ordered.slice(0, limit), truncated: ordered.length > limit };
  }
  
  function boundedDocumentSource(limit) {
    const maxBytes = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks = [];
    const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    const MAX_NODES = 100000;
    const MAX_ATTRIBUTES = 256;
    const MAX_ATTRIBUTE_CHARS = 4096;
    const MAX_TEXT_CHARS = 32768;
    let returnedBytes = 0;
    let budgetExhausted = false;
    let safetyTruncated = false;
    let visitedNodes = 0;
    let openShadowRoots = 0;
  
    const append = (raw) => {
      if (budgetExhausted) return false;
      let text = String(raw || "");
      const remaining = maxBytes - returnedBytes;
      if (remaining <= 0) { budgetExhausted = true; return false; }
      const maxChars = Math.max(1024, remaining);
      if (text.length > maxChars) { text = text.slice(0, maxChars); safetyTruncated = true; }
      const bytes = encoder.encode(text);
      if (bytes.byteLength <= remaining) {
        chunks.push(text);
        returnedBytes += bytes.byteLength;
        return true;
      }
      let end = remaining;
      let prefix = "";
      while (end > 0) {
        try { prefix = decoder.decode(bytes.slice(0, end)); break; }
        catch { end -= 1; }
      }
      if (prefix) chunks.push(prefix);
      returnedBytes += end;
      budgetExhausted = true;
      return false;
    };
    const bounded = (value, maxChars) => {
      const text = String(value || "");
      if (text.length > maxChars) safetyTruncated = true;
      return text.slice(0, maxChars);
    };
    const escapeText = (value) => bounded(value, MAX_TEXT_CHARS).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const escapeAttribute = (value) => bounded(value, MAX_ATTRIBUTE_CHARS).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  
    if (document.doctype) append(`<!DOCTYPE ${bounded(document.doctype.name || "html", 100)}>\n`);
    const stack = [...document.childNodes].reverse().map((node) => ({ node }));
    while (stack.length && !budgetExhausted) {
      if (visitedNodes >= MAX_NODES) { safetyTruncated = true; break; }
      const item = stack.pop();
      if (item.raw) { append(item.raw); continue; }
      if (item.close) { append(item.close); continue; }
      const node = item.node;
      if (!node || node.nodeType === 10) continue;
      visitedNodes += 1;
      if (node.nodeType === 1) {
        const tag = bounded(node.tagName || "div", 100).toLowerCase();
        if (!append(`<${tag}`)) break;
        const attributes = node.attributes || [];
        const attributeCount = Math.min(Number(attributes.length) || 0, MAX_ATTRIBUTES);
        for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex += 1) {
          const attribute = attributes[attributeIndex] || attributes.item?.(attributeIndex);
          if (!attribute) continue;
          if (!append(` ${bounded(attribute.name, 200)}="${escapeAttribute(attribute.value)}"`)) break;
        }
        if ((Number(attributes.length) || 0) > MAX_ATTRIBUTES) safetyTruncated = true;
        if (!append(">")) break;
        if (VOID_ELEMENTS.has(tag)) continue;
        stack.push({ close: `</${tag}>` });
        const shadowChildren = node.shadowRoot?.childNodes || [];
        if ((Number(shadowChildren.length) || 0) > 0) {
          openShadowRoots += 1;
          stack.push({ raw: "</template>" });
          for (let index = (Number(shadowChildren.length) || 0) - 1; index >= 0; index -= 1) stack.push({ node: shadowChildren[index] || shadowChildren.item?.(index) });
          stack.push({ raw: '<template data-machine-bridge-shadow-root="open">' });
        }
        const children = node.content?.childNodes || node.childNodes || [];
        for (let index = (Number(children.length) || 0) - 1; index >= 0; index -= 1) stack.push({ node: children[index] || children.item?.(index) });
        continue;
      }
      if (node.nodeType === 3) {
        const parentTag = String(node.parentElement?.tagName || "").toLowerCase();
        append(parentTag === "script" || parentTag === "style" ? bounded(node.data, MAX_TEXT_CHARS) : escapeText(node.data));
        continue;
      }
      if (node.nodeType === 8) append(`<!--${bounded(node.data, MAX_TEXT_CHARS).replaceAll("--", "- -")}-->`);
    }
    if (safetyTruncated && !budgetExhausted) append("<!-- machine-bridge source truncated by safety limit -->");
    return {
      source: chunks.join(""),
      bytes: returnedBytes,
      returned_bytes: returnedBytes,
      truncated: budgetExhausted || safetyTruncated || stack.length > 0,
      visited_nodes: visitedNodes,
      node_limit: MAX_NODES,
      open_shadow_roots: openShadowRoots,
      url: String(location.href || "").slice(0, 8192),
    };
  }
  
  async function assertExpectedNavigationTab(tabId, expectedTabUrl) {
    const expected = exactOptionalAuthorityString(expectedTabUrl, 32768);
    if (!expected) return;
    let current;
    try { current = await chrome.tabs.get(tabId); }
    catch { throw new Error("snapshot browser tab could not be verified before navigation dispatch; observe again"); }
    if (exactOptionalAuthorityString(current?.url, 32768) !== expected) {
      throw new Error("snapshot browser tab changed before navigation dispatch; observe again");
    }
  }

  async function assertExpectedHistoryDocument(tabId, expectedTabUrl, expectedDocumentEpoch, expectedHistoryEntryKey) {
    const expectedDocument = exactOptionalAuthorityString(expectedDocumentEpoch, 9000);
    const expectedHistoryEntry = exactOptionalAuthorityString(expectedHistoryEntryKey, 512);
    if (!expectedDocument && !expectedHistoryEntry) {
      await assertExpectedNavigationTab(tabId, expectedTabUrl);
      return;
    }
    let current;
    try { current = await documentState({ tabId }); }
    catch { throw new Error("snapshot history document could not be verified before dispatch; observe again"); }
    const expectedUrl = exactOptionalAuthorityString(expectedTabUrl, 32768);
    if (expectedUrl && (exactOptionalAuthorityString(current?.url, 32768) !== expectedUrl
        || exactOptionalAuthorityString(current?.document_url, 8192) !== expectedUrl)) {
      throw new Error("snapshot browser tab changed before navigation dispatch; observe again");
    }
    if (expectedDocument && exactOptionalAuthorityString(current?.document_epoch, 9000) !== expectedDocument) {
      throw new Error("snapshot history document changed before dispatch; observe again");
    }
    if (expectedHistoryEntry) {
      const currentHistoryEntry = exactOptionalAuthorityString(current?._machine_history_entry_key, 512);
      if (!currentHistoryEntry) throw new Error("snapshot history entry could not be verified before dispatch; observe again");
      if (currentHistoryEntry !== expectedHistoryEntry) throw new Error("snapshot history entry changed before dispatch; observe again");
    }
  }

  function snapshotBoundHistoryAction(params) {
    return Boolean(exactOptionalAuthorityString(params?.expectedDocumentEpoch, 9000)
      || exactOptionalAuthorityString(params?.expectedHistoryEntryKey, 512));
  }

  async function invokeSnapshotHistoryMutation(tab, params, state) {
    assertPageTab(tab);
    await executePageMutation({ tabId: tab.id, frameIds: [0] }, "historyAction", {
      action: params.action,
      expectedTabUrl: params.expectedTabUrl,
      expectedDocumentEpoch: params.expectedDocumentEpoch,
      expectedHistoryEntryKey: params.expectedHistoryEntryKey,
    }, state);
  }

  function normalizeBrowserActionParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser action parameters are invalid before dispatch");
    const action = exactOptionalText(params.action, "browser action", 32);
    const allowed = new Set([
      "navigate", "reload", "back", "forward", "click", "double_click", "hover", "fill", "type_text", "select",
      "check", "uncheck", "focus", "press", "submit", "scroll_into_view",
    ]);
    if (!allowed.has(action)) throw new Error("unsupported browser action");
    let frameId = params.frameId;
    if (frameId === undefined || frameId === null) frameId = null;
    else if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error("browser action frame id is invalid before dispatch");
    const waitFor = params.waitFor === undefined ? "none" : exactOptionalText(params.waitFor, "browser action waitFor", 32);
    if (!["none", "domcontentloaded", "complete"].includes(waitFor)) throw new Error("browser action waitFor is invalid before dispatch");
    const inputMode = params.inputMode === undefined ? "auto" : exactOptionalText(params.inputMode, "browser action inputMode", 16);
    if (!["auto", "trusted", "dom"].includes(inputMode)) throw new Error("browser action inputMode is invalid before dispatch");
    const elementTimeoutMs = exactBoundedInteger(params.elementTimeoutMs, "browser action elementTimeoutMs", 10000, 1, 60000);
    const expectedTabUrl = exactOptionalAuthorityString(params.expectedTabUrl, 32768);
    const expectedDocumentEpoch = exactOptionalAuthorityString(params.expectedDocumentEpoch, 9000);
    const expectedHistoryEntryKey = exactOptionalAuthorityString(params.expectedHistoryEntryKey, 512);
    let value = params.value;
    if (value === undefined || value === null) value = null;
    else value = exactOptionalText(value, "browser action value", 131072);
    let key = params.key;
    if (key === undefined) key = "";
    else key = exactOptionalText(key, "browser action key", 100);
    let url = params.url;
    if (action === "navigate") {
      if (url === undefined || url === null || url === "") throw new Error("navigate requires url");
      if (typeof url !== "string" || !/^(https?|file):/i.test(url) || url.includes("\0") || url.length > 32768) {
        throw new Error("navigate requires a valid absolute url before dispatch");
      }
    } else if (url !== undefined && url !== null && url !== "") throw new Error("url is only valid for navigate before dispatch");
    else url = "";
    return {
      ...params, action, frameId, waitFor, inputMode, elementTimeoutMs, expectedTabUrl, expectedDocumentEpoch, expectedHistoryEntryKey, value, key, url,
    };
  }

  async function browserAction(params, state) {
    params = normalizeBrowserActionParams(params);
    throwIfCancelled(state);
    const tab = await resolveTab(params.tabId);
    throwIfCancelled(state);
    if (params.action === "navigate") {
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        await assertExpectedNavigationTab(tab.id, params.expectedTabUrl);
        throwIfCancelled(state);
        const updated = await invokeBrowserNavigationMutation(() => chrome.tabs.update(tab.id, { url: params.url }));
        await awaitPostDispatchWait(waiter);
        return postActionTabMetadata(updated.id);
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    if (params.action === "reload") {
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        if (snapshotBoundHistoryAction(params)) {
          await invokeSnapshotHistoryMutation(tab, params, state);
        } else {
          await assertExpectedHistoryDocument(
            tab.id, params.expectedTabUrl, params.expectedDocumentEpoch, params.expectedHistoryEntryKey,
          );
          throwIfCancelled(state);
          await invokeBrowserNavigationMutation(() => chrome.tabs.reload(tab.id));
        }
        await awaitPostDispatchWait(waiter);
        return postActionTabMetadata(tab.id);
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    if (params.action === "back" || params.action === "forward") {
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        if (snapshotBoundHistoryAction(params)) {
          await invokeSnapshotHistoryMutation(tab, params, state);
        } else {
          await assertExpectedHistoryDocument(
            tab.id, params.expectedTabUrl, params.expectedDocumentEpoch, params.expectedHistoryEntryKey,
          );
          throwIfCancelled(state);
          if (params.action === "back") await invokeBrowserNavigationMutation(() => chrome.tabs.goBack(tab.id));
          else await invokeBrowserNavigationMutation(() => chrome.tabs.goForward(tab.id));
        }
        await awaitPostDispatchWait(waiter);
        return postActionTabMetadata(tab.id);
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    assertPageTab(tab);
    const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
    let result;
    try {
      result = await performPageAction(tab, params, state);
      await awaitPostDispatchWait(waiter);
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    const current = await postActionTabMetadata(tab.id);
    return { ...result, ...current };
  }
  
  function pageActionPayload(params) {
    return {
      action: params.action, selector: params.selector, value: params.value, key: params.key,
      elementTimeoutMs: params.elementTimeoutMs, expectedIdentity: params.expectedIdentity,
    };
  }

  async function performPageAction(tab, params, state) {
    throwIfCancelled(state);
    const rendererParams = pageActionPayload(params);
    const trustedActions = new Set(["click", "double_click", "hover", "press", "type_text"]);
    if (params.inputMode === "trusted" && !trustedActions.has(params.action)) {
      throw new Error("trusted input is unavailable for this action");
    }
    const wantsTrusted = params.inputMode !== "dom" && trustedActions.has(params.action);
    const topFrame = !Number.isInteger(params.frameId) || params.frameId === 0;
    if (wantsTrusted && !topFrame && params.inputMode === "trusted") {
      throw new Error("trusted input currently requires the top frame; use input_mode=dom for a subframe");
    }
    if (wantsTrusted && topFrame) {
      const api = globalThis.__machineBridgeDevtoolsInput;
      if (!api?.perform) {
        if (params.inputMode === "trusted") throw new Error("trusted input module is unavailable");
        const [fallback] = await executePageMutation(scriptTarget(tab.id, params.frameId, false), "action", rendererParams, state);
        return {
          ...fallback.result,
          input_mode: "dom",
          trusted_input_fallback: true,
          fallback_reason: "trusted_input_unavailable_before_dispatch",
        };
      }
      const [prepared] = await executePageMutation(scriptTarget(tab.id, params.frameId, false), "prepareAction", rendererParams, state);
      throwIfCancelled(state);
      try {
        await api.perform(tab.id, params.action, {
          point: prepared.result?.point,
          key: params.key || params.value || "Enter",
          text: params.value || "",
          beforeDispatch: () => throwIfCancelledBeforeTrustedInput(state),
        });
        return { ...prepared.result, input_mode: "trusted", trusted_input_fallback: false };
      } catch (error) {
        const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (${detail})`);
      }
    }
    throwIfCancelled(state);
    const [execution] = await executePageMutation(scriptTarget(tab.id, params.frameId, false), "action", rendererParams, state);
    return { ...execution.result, input_mode: "dom", trusted_input_fallback: false };
  }
  function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  function exactBrokerFrameId(value, label) {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }

  function exactBrokerSelector(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object before dispatch`);
    return value;
  }

  function normalizeBrokerFillFormParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser fill form parameters are invalid before dispatch");
    const allowed = new Set(["tabId", "frameId", "fields", "submit", "submitSelector", "waitFor", "elementTimeoutMs"]);
    for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`unknown browser fill form property before dispatch: ${key}`);
    if (!Array.isArray(params.fields) || params.fields.length < 1 || params.fields.length > 200) throw new Error("browser fill form fields are invalid before dispatch");
    const frameId = exactBrokerFrameId(params.frameId, "browser fill form frame id");
    const submit = exactBoolean(params.submit, "browser fill form submit", false);
    const submitSelector = params.submitSelector === undefined || params.submitSelector === null ? null : exactBrokerSelector(params.submitSelector, "browser fill form submit selector");
    const waitFor = params.waitFor === undefined ? "none" : exactOptionalText(params.waitFor, "browser fill form waitFor", 32);
    if (!["none", "domcontentloaded", "complete"].includes(waitFor)) throw new Error("browser fill form waitFor is invalid before dispatch");
    const elementTimeoutMs = exactBoundedInteger(params.elementTimeoutMs, "browser fill form elementTimeoutMs", 10000, 1, 60000);
    let totalValueBytes = 0;
    const fields = params.fields.map((field, index) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`browser fill form field ${index} is invalid before dispatch`);
      const allowedField = new Set(["selector", "value", "action", "sensitive"]);
      for (const key of Object.keys(field)) if (!allowedField.has(key)) throw new Error(`unknown browser fill form field ${index} property before dispatch: ${key}`);
      const selector = exactBrokerSelector(field.selector, `browser fill form field ${index} selector`);
      if (typeof field.action !== "string" || !["fill", "select", "check", "uncheck", "click"].includes(field.action)) throw new Error(`browser fill form field ${index} action is invalid before dispatch`);
      if (typeof field.sensitive !== "boolean") throw new Error(`browser fill form field ${index} sensitive flag must be boolean before dispatch`);
      let value = field.value;
      if (["fill", "select"].includes(field.action)) {
        if (typeof value !== "string" || value.includes("\0") || value.length > 128 * 1024) throw new Error(`browser fill form field ${index} value is invalid before dispatch`);
        totalValueBytes += utf8ByteLength(value);
        if (totalValueBytes > 4 * 1024 * 1024) throw new Error("browser fill form values exceed the 4 MiB aggregate budget before dispatch");
      } else if (value !== undefined && value !== null) throw new Error(`browser fill form field ${index} value is not valid before dispatch`);
      else value = null;
      return { selector, value, action: field.action, sensitive: field.sensitive };
    });
    return { tabId: params.tabId, frameId, fields, submit, submitSelector, waitFor, elementTimeoutMs };
  }

  function fillFormRendererPayload(params) {
    return { fields: params.fields, submit: params.submit, submitSelector: params.submitSelector, elementTimeoutMs: params.elementTimeoutMs };
  }

  function decodedBase64Bytes(value) {
    if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding;
  }

  function normalizeBrokerUploadParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser upload parameters are invalid before dispatch");
    const allowed = new Set(["tabId", "frameId", "selector", "files", "elementTimeoutMs"]);
    for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`unknown browser upload property before dispatch: ${key}`);
    const frameId = exactBrokerFrameId(params.frameId, "browser upload frame id");
    const selector = exactBrokerSelector(params.selector, "browser upload selector");
    const elementTimeoutMs = exactBoundedInteger(params.elementTimeoutMs, "browser upload elementTimeoutMs", 10000, 1, 60000);
    if (!Array.isArray(params.files) || params.files.length < 1 || params.files.length > 8) throw new Error("browser upload files are invalid before dispatch");
    let totalBytes = 0;
    const files = params.files.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`browser upload file ${index} is invalid before dispatch`);
      for (const key of Object.keys(item)) if (!["filename", "mime", "data"].includes(key)) throw new Error(`unknown browser upload file ${index} property before dispatch: ${key}`);
      if (typeof item.filename !== "string" || !item.filename || item.filename === "." || item.filename === ".." || item.filename.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(item.filename)) throw new Error(`browser upload file ${index} filename is invalid before dispatch`);
      if (typeof item.mime !== "string" || item.mime.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item.mime)) throw new Error(`browser upload file ${index} mime is invalid before dispatch`);
      const bytes = decodedBase64Bytes(item.data);
      if (bytes === null) throw new Error(`browser upload file ${index} data is invalid before dispatch`);
      totalBytes += bytes;
      if (totalBytes > 5 * 1024 * 1024) throw new Error("browser upload files exceed the 5 MiB aggregate budget before dispatch");
      return { filename: item.filename, mime: item.mime, data: item.data };
    });
    return { tabId: params.tabId, frameId, selector, files, elementTimeoutMs };
  }

  function uploadRendererPayload(params) {
    return { selector: params.selector, files: params.files, elementTimeoutMs: params.elementTimeoutMs };
  }

  async function fillForm(params, state) {
    params = normalizeBrokerFillFormParams(params);
    throwIfCancelled(state);
    const tab = await resolveTab(params.tabId);
    throwIfCancelled(state);
    assertPageTab(tab);
    const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
    let execution;
    try {
      [execution] = await executePageMutation(scriptTarget(tab.id, params.frameId, false), "fillForm", fillFormRendererPayload(params), state);
      await awaitPostDispatchWait(waiter);
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    const current = await postActionTabMetadata(tab.id);
    return { ...execution.result, ...current };
  }
  
  async function uploadFiles(params, state) {
    params = normalizeBrokerUploadParams(params);
    throwIfCancelled(state);
    const tab = await resolveTab(params.tabId);
    throwIfCancelled(state);
    assertPageTab(tab);
    const [execution] = await executePageMutation(scriptTarget(tab.id, params.frameId, false), "uploadFiles", uploadRendererPayload(params), state);
    const current = await postActionTabMetadata(tab.id);
    return { ...execution.result, ...current };
  }
  
  async function screenshot(params, state) {
    const format = exactImageFormat(params.format, "browser screenshot format");
    const quality = exactBoundedInteger(params.quality, "browser screenshot quality", 90, 1, 100);
    const allowTabSwitch = exactBoolean(params.allowTabSwitch, "browser screenshot allowTabSwitch", true);
    throwIfCancelled(state);
    const tab = await resolveTab(params.tabId);
    const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    throwIfCancelled(state);
    const changedActiveTab = previousActive?.id !== tab.id;
    if (changedActiveTab && !allowTabSwitch) {
      throw new Error("browser screenshot target tab is not active for non-disruptive capture");
    }
    if (changedActiveTab && !previousActive?.id) throw new Error("browser screenshot cannot safely switch tabs without a restore baseline");
    let data = null;
    let failure = null;
    let captureActive = null;
    let activationAttempted = false;
    try {
      if (changedActiveTab) {
        let activationBaseline = null;
        try { [activationBaseline] = await chrome.tabs.query({ active: true, windowId: tab.windowId }); }
        catch { throw new Error("browser screenshot could not revalidate the active tab before temporary activation"); }
        if (activationBaseline?.id !== previousActive.id) {
          throw new Error("browser screenshot active tab changed before temporary activation");
        }
        throwIfCancelled(state);
        activationAttempted = true;
        let activated;
        try { activated = await chrome.tabs.update(tab.id, { active: true }); }
        catch (error) {
          const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
          throw new Error(`browser screenshot temporary tab activation may have been dispatched; the outcome is unknown. Inspect tabs before retrying. (${detail})`);
        }
        if (activated?.id !== tab.id || activated.windowId !== tab.windowId) {
          throw new Error("browser screenshot temporary tab activation may have been dispatched; the outcome is unknown because target window provenance changed. Inspect tabs before retrying.");
        }
      }
      throwIfCancelled(state);
      try { [captureActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId }); }
      catch { failure = new Error("browser screenshot could not verify target tab at capture boundary"); }
      if (!failure && captureActive?.id !== tab.id) failure = new Error("browser screenshot target tab was not active at capture boundary");
      if (!failure) {
        throwIfCancelled(state);
        try {
          data = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
          throwIfCancelled(state);
        } catch (error) {
          failure = error;
        }
      }
      if (!failure) {
        try { [captureActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId }); }
        catch { failure = new Error("browser screenshot could not verify the active tab after capture"); }
        if (!failure && captureActive?.id !== tab.id) failure = new Error("browser screenshot active tab changed during capture");
      }
    } finally {
      if (activationAttempted && previousActive?.id) await restoreScreenshotActiveTab(tab, previousActive);
    }
    if (failure) throw failure;
    if (typeof data !== "string" || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data)) {
      throw new Error("browser screenshot returned invalid image data");
    }
    return { ...publicTab(captureActive), tab_metadata_verified: true, data };
  }

  async function restoreScreenshotActiveTab(tab, previousActive) {
    let currentActive = null;
    try { [currentActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId }); }
    catch { throw new Error("browser screenshot could not verify active-tab restoration"); }
    if (!currentActive?.id) throw new Error("browser screenshot could not verify active-tab restoration");
    if (currentActive.id !== tab.id) return;
    let restoreBaseline = null;
    try { restoreBaseline = await chrome.tabs.get(previousActive.id); }
    catch { throw new Error("browser screenshot could not restore the previous active tab"); }
    if (restoreBaseline?.windowId !== tab.windowId) throw new Error("browser screenshot could not restore the previous active tab");
    try {
      const restoredTab = await chrome.tabs.update(previousActive.id, { active: true });
      if (restoredTab?.id !== previousActive.id || restoredTab.windowId !== tab.windowId) throw new Error("restore window changed");
      const [restored] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (restored?.id !== previousActive.id) throw new Error("restore verification mismatch");
    } catch (error) {
      const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`browser screenshot restoration may have been dispatched; the active-tab outcome is unknown. Inspect tabs before retrying. (${detail})`);
    }
  }
  
  async function postActionTabMetadata(tabId) {
    try {
      return { ...publicTab(await chrome.tabs.get(tabId)), tab_metadata_verified: true };
    } catch {
      return { tab_id: tabId, tab_metadata_verified: false };
    }
  }

  function publicTab(tab) {
    return { tab_id: tab.id, window_id: tab.windowId, title: tab.title || "", url: tab.url || "", status: tab.status || "" };
  }
  
  function assertPageTab(tab) {
    const url = exactOptionalAuthorityString(tab?.url, 32768);
    if (!url || !/^(https?|file):/i.test(url)) throw new Error("this page cannot be scripted by a browser extension");
  }
  
  function beginTabWait(tabId, mode, requestTimeoutMs = 30000, state = null) {
    if (!mode || mode === "none") return { promise: Promise.resolve(), cancel() {} };
    const waitTimeoutMs = Math.max(1000, boundedRequestTimeout(requestTimeoutMs) - 1000);
    let settled = false;
    let navigationStarted = false;
    let pollTimer = null;
    let cancellationTimer = null;
    let timeout = null;
    let lastPollError = "";
    let resolveWait;
    let rejectWait;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveWait = resolvePromise;
      rejectWait = rejectPromise;
    });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(pollTimer);
      clearTimeout(cancellationTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved?.removeListener(removedListener);
    };
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectWait(error); else resolveWait();
    };
    const pollReadyState = async () => {
      if (settled || !navigationStarted || mode !== "domcontentloaded") return;
      try {
        const [execution] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState });
        if (["interactive", "complete"].includes(execution?.result)) {
          settle();
          return;
        }
      } catch (error) {
        lastPollError = String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
      }
      pollTimer = setTimeout(pollReadyState, 100);
    };
    const pollCancellation = () => {
      if (settled) return;
      if (state?.cancelled) { settle(new Error("browser request cancelled")); return; }
      cancellationTimer = setTimeout(pollCancellation, 100);
    };
    const removedListener = (removedId) => {
      if (removedId === tabId) settle(new Error("browser tab closed during navigation wait"));
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || settled) return;
      if (changeInfo.status === "loading" || typeof changeInfo.url === "string") navigationStarted = true;
      if (!navigationStarted) return;
      if (mode === "complete" && (changeInfo.status === "complete" || (typeof changeInfo.url === "string" && tab.status === "complete"))) settle();
      if (mode === "domcontentloaded") void pollReadyState();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved?.addListener(removedListener);
    pollCancellation();
    timeout = setTimeout(() => settle(new Error(`browser navigation wait timed out${lastPollError ? `: ${lastPollError}` : ""}`)), waitTimeoutMs);
    return { promise, cancel: () => settle() };
  }

  async function awaitPostDispatchWait(waiter) {
    try {
      await waiter.promise;
    } catch (error) {
      const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`browser action may have been dispatched; the action outcome is unknown because post-dispatch wait failed. Inspect the page before retrying. (${detail})`);
    }
  }

  async function invokeBrowserNavigationMutation(operation) {
    try {
      return await operation();
    } catch (error) {
      const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`browser action may have been dispatched; the action outcome is unknown because the navigation mutation API failed. Inspect the page before retrying. (${detail})`);
    }
  }

  async function invokeBrowserTabMutation(operation, phase) {
    try {
      return await operation();
    } catch (error) {
      const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`browser tab mutation may have been dispatched; the outcome is unknown during ${phase}. Inspect tabs before retrying. (${detail})`);
    }
  }
  
  async function executePageMutation(target, method, params, state) {
    await chrome.scripting.executeScript({ target, files: ["page-automation.js"] });
    throwIfCancelled(state);
    let executions;
    try {
      executions = await chrome.scripting.executeScript({
        target,
        func: async (operation, payload, expectedVersion) => {
          const protocol = "machine_bridge_page_mutation_v1";
          try {
            const api = globalThis.__machineBridgePageAutomation;
            if (!api || api.version !== expectedVersion) throw new Error("page automation module version mismatch");
            if (typeof api[operation] !== "function") throw new Error("page automation module is unavailable");
            return { protocol, ok: true, result: await api[operation](payload) };
          } catch (error) {
            return { protocol, ok: false, error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 1000) };
          }
        },
        args: [method, params, PAGE_AUTOMATION_VERSION],
      });
    } catch (error) {
      throw pageMutationDispatchUnknown(error);
    }
    const settlement = Array.isArray(executions) && executions.length === 1 ? executions[0]?.result : null;
    if (settlement?.protocol !== "machine_bridge_page_mutation_v1") {
      throw pageMutationDispatchUnknown(new Error("page mutation settlement response was unavailable"));
    }
    if (settlement.ok === false) {
      if (typeof settlement.error !== "string" || !settlement.error || settlement.error.includes("\0") || settlement.error.length > 1000) {
        throw pageMutationSettlementUnknown();
      }
      throw new Error(settlement.error);
    }
    if (settlement.ok !== true) throw pageMutationSettlementUnknown();
    return [{ ...executions[0], result: settlement.result }];
  }

  function pageMutationSettlementUnknown() {
    return new Error("browser action may have been dispatched; the action outcome is unknown because the page mutation settlement was malformed. Inspect the page before retrying.");
  }

  function pageMutationDispatchUnknown(error) {
    const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
    return new Error(`browser action may have been dispatched; the action outcome is unknown because the page mutation scripting call did not settle. Inspect the page before retrying. (${detail})`);
  }

  function executePageAutomation(target, method, params) {
    return chrome.scripting.executeScript({ target, files: ["page-automation.js"] })
      .then(() => chrome.scripting.executeScript({
        target,
        func: (operation, payload) => {
          const api = globalThis.__machineBridgePageAutomation;
          if (!api || typeof api[operation] !== "function") throw new Error("page automation module is unavailable");
          return api[operation](payload);
        },
        args: [method, params],
      }));
  }
  
  function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  function boundedRequestTimeout(value) {
    if (!Number.isSafeInteger(value)) return 30000;
    return Math.max(1000, Math.min(185000, value));
  }

  function requestCancelled(error) {
    return String(error?.message || error) === "browser request cancelled";
  }

  function throwIfCancelled(state) {
    if (state?.cancelled) throw new Error("browser request cancelled");
  }

  function throwIfCancelledBeforeTrustedInput(state) {
    if (!state?.cancelled) return;
    const error = new Error("browser request cancelled");
    Object.defineProperty(error, "machineBridgeBeforeDispatchAbort", { value: true });
    throw error;
  }

  Object.defineProperty(globalThis, "__machineBridgeBrowserOperations", {
    value: Object.freeze({ dispatch, methodMayMutate, responsePayload, boundedRequestTimeout, boundedDocumentSource }),
    configurable: false,
  });
})();
