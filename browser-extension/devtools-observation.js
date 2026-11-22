(() => {
  if (globalThis.__machineBridgeDevtoolsObservation) return;

  const ACTIONABLE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox",
    "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "treeitem",
  ]);
  const MAX_TEXT = 2000;
  const SENSITIVE_IDENTITY = /(?:password|passwd|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification|cvc|cvv|security[-_ ]?code|card[-_ ]?number)/i;

  async function capture(tabId, options = {}, state = null) {
    const session = globalThis.__machineBridgeDevtoolsSession;
    if (!session?.run) throw new Error("DevTools session module is unavailable");
    if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("tabId is invalid");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("DevTools observation options are invalid");
    const maxNodes = exactBoundedInteger(options.maxNodes, "maxNodes", 600, 1, 2000);
    const maxFrames = exactBoundedInteger(options.maxFrames, "maxFrames", 32, 1, 64);
    const depth = exactBoundedInteger(options.depth, "depth", 12, 1, 16);
    const includeValues = exactBoolean(options.includeValues, "includeValues", false);
    const includeScreenshot = exactBoolean(options.includeScreenshot, "includeScreenshot", true);
    const format = exactImageFormat(options.format);
    const quality = exactBoundedInteger(options.quality, "quality", 90, 1, 100);
    const focusQuery = normalizedQuery(options.focusQuery);

    return session.run(tabId, async ({ send }) => {
      throwIfCancelled(state);
      await send("Page.enable");
      throwIfCancelled(state);
      await send("Accessibility.enable");
      throwIfCancelled(state);

      const frameTreeBefore = await send("Page.getFrameTree");
      const frameTree = frameTreeBefore?.frameTree;
      const allFramesBefore = flattenFrameTree(frameTree);
      const frames = allFramesBefore.slice(0, maxFrames);
      const rootBefore = frames[0] || null;
      const rootFrameId = protocolString(frameTree?.frame?.id);
      const metrics = await send("Page.getLayoutMetrics").catch((error) => {
        if (error?.machineBridgeDevtoolsTimeout === true) throw error;
        return null;
      });
      throwIfCancelled(state);

      let domSnapshot = null;
      try {
        domSnapshot = await send("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includePaintOrder: true,
          includeDOMRects: false,
        });
      } catch (error) {
        if (error?.machineBridgeDevtoolsTimeout === true) throw error;
      }
      throwIfCancelled(state);

      const axRaw = [];
      const axFrameFailures = [];
      for (const frame of frames) {
        throwIfCancelled(state);
        const frameId = protocolString(frame?.id);
        if (!frameId) {
          axFrameFailures.push("");
          continue;
        }
        try {
          const response = await send("Accessibility.getFullAXTree", { depth, frameId });
          for (const node of Array.isArray(response?.nodes) ? response.nodes : []) axRaw.push(node);
        } catch (error) {
          if (error?.machineBridgeDevtoolsTimeout === true) throw error;
          axFrameFailures.push(frameId);
        }
      }

      let screenshot = null;
      if (includeScreenshot) {
        try {
          screenshot = await send("Page.captureScreenshot", {
            format,
            ...(format === "jpeg" ? { quality } : {}),
            fromSurface: true,
            captureBeyondViewport: false,
            optimizeForSpeed: true,
          });
        } catch (error) {
          if (error?.machineBridgeDevtoolsTimeout === true) throw error;
        }
      }
      throwIfCancelled(state);

      const frameTreeAfter = await send("Page.getFrameTree");
      const rootAfter = flattenFrameTree(frameTreeAfter?.frameTree)[0] || null;
      const navigationCoherent = sameDocumentEpoch(rootBefore, rootAfter);
      const geometry = geometryByBackendNode(domSnapshot);
      const accessibility = normalizeAccessibility(axRaw, geometry, metrics, {
        maxNodes,
        includeValues,
        rootFrameId,
        focusQuery,
      });

      return {
        protocol: "cdp-1.3",
        document_epoch: rootBefore ? documentEpoch(rootBefore) : "",
        navigation_coherent: navigationCoherent,
        frame_tree: frames.map((frame) => ({
          id: protocolString(frame?.id),
          parent_id: protocolString(frame?.parentId),
          loader_id: protocolString(frame?.loaderId),
          url: protocolString(frame?.url),
          name: protocolString(frame?.name, 500),
        })),
        frames_truncated: allFramesBefore.length > maxFrames,
        accessibility: {
          kind: "chromium-accessibility",
          nodes: accessibility.nodes,
          returned_nodes: accessibility.nodes.length,
          observed_nodes: accessibility.observedNodes,
          ignored_nodes: accessibility.ignoredNodes,
          truncated: accessibility.truncated,
          depth,
          query_matched: accessibility.queryMatched,
          query_match_count: accessibility.queryMatchCount,
          query_search_exhaustive: focusQuery ? false : null,
          top_query_score: accessibility.topQueryScore,
          failed_frame_count: axFrameFailures.length,
          available: frames.length > 0 && axFrameFailures.length < frames.length,
        },
        components: {
          layout_metrics: Boolean(metrics),
          dom_snapshot: Boolean(domSnapshot),
          accessibility: frames.length > 0 && axFrameFailures.length < frames.length,
          screenshot_requested: includeScreenshot,
          screenshot: validBase64Payload(screenshot?.data),
        },
        viewport: normalizeViewport(metrics),
        screenshot: validBase64Payload(screenshot?.data)
          ? { mime_type: format === "jpeg" ? "image/jpeg" : "image/png", data: screenshot.data }
          : null,
      };
    });
  }

  function normalizeAccessibility(rawNodes, geometry, metrics, { maxNodes, includeValues, rootFrameId, focusQuery }) {
    const candidates = [];
    let ignoredNodes = 0;
    for (let index = 0; index < rawNodes.length; index += 1) {
      const raw = rawNodes[index];
      if (!raw || raw.ignored === true) { ignoredNodes += 1; continue; }
      const role = bounded(axValue(raw.role), 200).toLowerCase();
      const name = bounded(axValue(raw.name), 1000);
      const description = bounded(axValue(raw.description), 1000);
      const properties = propertyMap(raw.properties);
      const backendNodeId = Number.isSafeInteger(raw.backendDOMNodeId) && raw.backendDOMNodeId > 0 ? raw.backendDOMNodeId : 0;
      const layout = backendNodeId ? geometry.get(backendNodeId) || null : null;
      const frameId = protocolString(raw.frameId) || protocolString(layout?.frameId) || protocolString(rootFrameId);
      const sensitive = isSensitive(role, name, description, properties);
      const node = {
        ax_id: bounded(raw.nodeId, 200),
        parent_ax_id: bounded(raw.parentId, 200),
        backend_dom_node_id: backendNodeId || null,
        frame_id: frameId,
        role,
        name,
        description,
        disabled: booleanProperty(properties.disabled),
        focused: booleanProperty(properties.focused),
        focusable: booleanProperty(properties.focusable),
        editable: booleanProperty(properties.editable),
        checked: scalarProperty(properties.checked),
        selected: booleanProperty(properties.selected),
        expanded: booleanProperty(properties.expanded),
        required: booleanProperty(properties.required),
        sensitive,
        clickable: layout?.clickable === true || ACTIONABLE_ROLES.has(role),
        bounding_box: layout?.bbox || null,
        paint_order: Number.isFinite(layout?.paintOrder) ? layout.paintOrder : null,
      };
      if (includeValues && !sensitive && !["textbox", "searchbox"].includes(role)) {
        const value = axValue(raw.value);
        if (value !== "") node.value = bounded(value, MAX_TEXT);
      }
      const queryScore = focusMatchScore(node, focusQuery);
      const score = salienceScore(node, metrics, index, queryScore);
      candidates.push({ node, score, queryScore, index });
    }
    candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    const queryMatches = focusQuery ? candidates.filter((candidate) => candidate.queryScore > 0) : [];
    const selected = candidates.slice(0, maxNodes).map(({ node, queryScore }) => ({
      ...node,
      ...(focusQuery ? { focus_match_score: Math.round(queryScore) } : {}),
    }));
    return {
      nodes: selected,
      observedNodes: rawNodes.length,
      ignoredNodes,
      truncated: candidates.length > selected.length,
      queryMatched: focusQuery ? queryMatches.length > 0 : null,
      queryMatchCount: focusQuery ? queryMatches.length : null,
      topQueryScore: focusQuery && queryMatches.length ? Math.max(...queryMatches.map((candidate) => candidate.queryScore)) : null,
    };
  }

  function geometryByBackendNode(snapshot) {
    const map = new Map();
    const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
    for (const document of Array.isArray(snapshot?.documents) ? snapshot.documents : []) {
      const frameId = stringAt(strings, document?.frameId);
      const scrollX = finiteNumber(document?.scrollOffsetX, 0);
      const scrollY = finiteNumber(document?.scrollOffsetY, 0);
      const backendIds = Array.isArray(document?.nodes?.backendNodeId) ? document.nodes.backendNodeId : [];
      const clickableIndexes = new Set(Array.isArray(document?.nodes?.isClickable?.index) ? document.nodes.isClickable.index : []);
      const layoutIndexes = Array.isArray(document?.layout?.nodeIndex) ? document.layout.nodeIndex : [];
      const bounds = Array.isArray(document?.layout?.bounds) ? document.layout.bounds : [];
      const paintOrders = Array.isArray(document?.layout?.paintOrders) ? document.layout.paintOrders : [];
      const layoutByNodeIndex = new Map();
      for (let layoutIndex = 0; layoutIndex < layoutIndexes.length; layoutIndex += 1) {
        const nodeIndex = layoutIndexes[layoutIndex];
        if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0) continue;
        const rect = normalizeRect(bounds[layoutIndex], scrollX, scrollY);
        layoutByNodeIndex.set(nodeIndex, {
          bbox: rect,
          paintOrder: finiteNumber(paintOrders[layoutIndex], null),
        });
      }
      for (let nodeIndex = 0; nodeIndex < backendIds.length; nodeIndex += 1) {
        const backendNodeId = backendIds[nodeIndex];
        if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) continue;
        const layout = layoutByNodeIndex.get(nodeIndex) || null;
        map.set(backendNodeId, {
          frameId,
          bbox: layout?.bbox || null,
          paintOrder: layout?.paintOrder ?? null,
          clickable: clickableIndexes.has(nodeIndex),
        });
      }
    }
    return map;
  }

  function focusMatchScore(node, focusQuery) {
    if (!focusQuery) return 0;
    const identity = `${node.role} ${node.name} ${node.description}`.trim().replace(/\s+/g, " ").toLowerCase();
    if (identity === focusQuery) return 240;
    if (identity.includes(focusQuery)) return 180;
    const tokens = focusQuery.split(" ").filter((token) => token.length > 1);
    return Math.min(120, tokens.filter((token) => identity.includes(token)).length * 30);
  }

  function salienceScore(node, metrics, index, queryScore) {
    let score = 0;
    if (ACTIONABLE_ROLES.has(node.role)) score += 100;
    if (node.clickable) score += 30;
    if (node.focused) score += 50;
    if (node.focusable) score += 12;
    if (node.editable) score += 20;
    if (node.name) score += 12;
    if (node.bounding_box) {
      score += 10;
      if (intersectsViewport(node.bounding_box, metrics)) score += 40;
      const area = Math.max(0, node.bounding_box.width * node.bounding_box.height);
      if (area > 0 && area < 2_000_000) score += Math.min(10, Math.log10(area + 1) * 2);
    }
    if (node.disabled === true) score -= 20;
    score += queryScore;
    if (["genericcontainer", "none", "unknown", "statictext", "inlinetextbox"].includes(node.role)) score -= 40;
    score -= index / 1_000_000;
    return score;
  }

  function intersectsViewport(rect, metrics) {
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || null;
    if (!viewport) return false;
    const width = finiteNumber(viewport.clientWidth, finiteNumber(viewport.width, 0));
    const height = finiteNumber(viewport.clientHeight, finiteNumber(viewport.height, 0));
    if (!(width > 0 && height > 0)) return false;
    return rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < width && rect.y < height;
  }

  function normalizedQuery(value) {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > 1000 || value.includes("\0")) throw new Error("focusQuery is invalid");
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function normalizeViewport(metrics) {
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport || {};
    const layout = metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
    return {
      x: finiteNumber(viewport.pageX, finiteNumber(layout.pageX, 0)),
      y: finiteNumber(viewport.pageY, finiteNumber(layout.pageY, 0)),
      width: finiteNumber(viewport.clientWidth, finiteNumber(layout.clientWidth, 0)),
      height: finiteNumber(viewport.clientHeight, finiteNumber(layout.clientHeight, 0)),
      scale: finiteNumber(viewport.scale, 1),
    };
  }

  function flattenFrameTree(tree) {
    if (!tree?.frame) return [];
    const out = [];
    const stack = [tree];
    while (stack.length) {
      const current = stack.pop();
      if (!current?.frame) continue;
      out.push(current.frame);
      const children = Array.isArray(current.childFrames) ? current.childFrames : [];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return out;
  }

  function sameDocumentEpoch(left, right) {
    if (!left || !right) return false;
    const leftId = protocolString(left.id, 200);
    const rightId = protocolString(right.id, 200);
    const leftLoaderId = protocolString(left.loaderId, 300);
    const rightLoaderId = protocolString(right.loaderId, 300);
    const leftUrl = protocolString(left.url, 8192);
    const rightUrl = protocolString(right.url, 8192);
    return Boolean(leftId && rightId && leftLoaderId && rightLoaderId && leftUrl && rightUrl)
      && leftId === rightId && leftLoaderId === rightLoaderId && leftUrl === rightUrl;
  }

  function documentEpoch(frame) {
    const id = protocolString(frame?.id, 200);
    const loaderId = protocolString(frame?.loaderId, 300);
    const url = protocolString(frame?.url, 8192);
    return id && loaderId && url ? `${id}:${loaderId}:${url}` : "";
  }

  function propertyMap(properties) {
    const out = Object.create(null);
    for (const property of Array.isArray(properties) ? properties : []) {
      const name = protocolString(property?.name, 200);
      if (name) out[name] = property?.value;
    }
    return out;
  }

  function axValue(value) {
    const raw = value?.value;
    if (raw === undefined || raw === null) return "";
    if (["string", "number", "boolean"].includes(typeof raw)) return String(raw);
    return "";
  }

  function scalarProperty(value) {
    const raw = value?.value;
    if (raw === undefined || raw === null) return null;
    if (["string", "number", "boolean"].includes(typeof raw)) return raw;
    return null;
  }

  function booleanProperty(value) {
    const raw = value?.value;
    return typeof raw === "boolean" ? raw : null;
  }

  function isSensitive(role, name, description, properties) {
    if (role === "passwordtext" || role === "password") return true;
    const identity = `${name} ${description} ${axValue(properties.autocomplete)}`;
    return SENSITIVE_IDENTITY.test(identity);
  }

  function normalizeRect(raw, scrollX, scrollY) {
    if (!Array.isArray(raw) || raw.length < 4) return null;
    const [x, y, width, height] = raw;
    if (![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value)) || width < 0 || height < 0) return null;
    return {
      x: round2(x - scrollX),
      y: round2(y - scrollY),
      width: round2(width),
      height: round2(height),
    };
  }

  function stringAt(strings, index) {
    if (!Number.isSafeInteger(index) || index < 0) return "";
    return protocolString(strings[index]);
  }

  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function bounded(value, max) {
    return String(value ?? "").slice(0, max);
  }

  function protocolString(value, maxLength = 32768) {
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) return "";
    return value;
  }

  function exactBoundedInteger(value, label, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
    return value;
  }

  function exactBoolean(value, label, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
    return value;
  }

  function exactImageFormat(value) {
    if (value === undefined) return "png";
    if (value !== "png" && value !== "jpeg") throw new Error("format must be png or jpeg");
    return value;
  }

  function validBase64Payload(value) {
    if (typeof value !== "string" || !value || value.length > 64 * 1024 * 1024 || value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  }

  const MAX_NETWORK_ENTRIES = 200;
  const MAX_NETWORK_TABS = 64;
  const SENSITIVE_HEADER_PATTERN = /(?:authorization|cookie|token|secret|api[-_]?key|apikey|passw|session|credential|signature|jwt|bearer|csrf|xsrf|www-authenticate|proxy-authenticate|private[-_]?key)/i;
  const SENSITIVE_QUERY_PATTERN = /(?:token|secret|api[-_]?key|apikey|passw|auth|session|cred|sig|signature|jwt|^(?:code|key)$)/i;
  const networkLogsByTab = new Map();

  if (typeof chrome !== "undefined" && chrome?.tabs?.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      networkLogsByTab.delete(removedTabId);
    });
  }

  function getTabNetworkBuffer(tabId) {
    let buffer = networkLogsByTab.get(tabId);
    if (!buffer) {
      if (networkLogsByTab.size >= MAX_NETWORK_TABS) {
        const oldestKey = networkLogsByTab.keys().next().value;
        if (oldestKey !== undefined) networkLogsByTab.delete(oldestKey);
      }
      buffer = [];
      networkLogsByTab.set(tabId, buffer);
    }
    return buffer;
  }

  function pushTabNetworkEntry(tabId, entry) {
    const buffer = getTabNetworkBuffer(tabId);
    buffer.push(entry);
    if (buffer.length > MAX_NETWORK_ENTRIES) buffer.splice(0, buffer.length - MAX_NETWORK_ENTRIES);
    return entry;
  }

  function redactFragment(hash) {
    if (!hash || hash === "#") return hash;
    const body = hash.slice(1);
    if (!body.includes("=")) {
      return /(?:eyJ|token|secret|auth|session|bearer)/i.test(body) || body.length >= 24 ? "#[REDACTED]" : hash;
    }
    const parts = body.split("&").map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part;
      const key = part.slice(0, eq);
      let decoded = key;
      try { decoded = decodeURIComponent(key); } catch { /* keep raw key */ }
      return SENSITIVE_QUERY_PATTERN.test(decoded) ? `${key}=[REDACTED]` : part;
    });
    return `#${parts.join("&")}`;
  }

  function redactNetworkUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return "";
    try {
      const parsed = new URL(rawUrl);
      if (parsed.username) parsed.username = "[REDACTED]";
      if (parsed.password) parsed.password = "[REDACTED]";
      for (const name of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY_PATTERN.test(name)) parsed.searchParams.set(name, "[REDACTED]");
      }
      if (parsed.hash) parsed.hash = redactFragment(parsed.hash);
      return parsed.toString().slice(0, 2048);
    } catch {
      return "[REDACTED_INVALID_URL]";
    }
  }

  function redactNetworkHeaders(headers) {
    const out = Object.create(null);
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return out;
    let count = 0;
    for (const [key, value] of Object.entries(headers)) {
      if (count >= 40) break;
      const lower = String(key).toLowerCase();
      if (SENSITIVE_HEADER_PATTERN.test(lower)) {
        out[key] = "[REDACTED]";
      } else if (lower === "referer" || lower === "referrer" || lower === "location") {
        out[key] = redactNetworkUrl(String(value ?? ""));
      } else {
        out[key] = String(value ?? "").slice(0, 256);
      }
      count += 1;
    }
    return out;
  }

  function recordCdpNetworkEvent(tabId, byRequestId, method, eventParams) {
    const requestId = protocolString(eventParams?.requestId, 200);
    if (!requestId) return;
    if (method === "Network.requestWillBeSent") {
      if (eventParams?.redirectResponse && byRequestId.has(requestId)) {
        const prior = byRequestId.get(requestId);
        const redir = eventParams.redirectResponse;
        if (typeof redir.status === "number") prior.status = redir.status;
        if (redir.mimeType) prior.mime_type = protocolString(redir.mimeType, 128);
        prior.response_headers = redactNetworkHeaders(redir.headers);
      }
      const req = eventParams?.request || {};
      const entry = pushTabNetworkEntry(tabId, {
        request_id: requestId,
        url: redactNetworkUrl(req.url),
        method: protocolString(req.method, 32) || "GET",
        resource_type: protocolString(eventParams?.type, 64),
        status: null,
        mime_type: "",
        request_headers: redactNetworkHeaders(req.headers),
        response_headers: Object.create(null),
        failed: false,
        error_text: "",
        encoded_data_length: null,
      });
      byRequestId.set(requestId, entry);
      return;
    }
    if (method === "Network.responseReceived") {
      const res = eventParams?.response || {};
      let entry = byRequestId.get(requestId);
      if (!entry) {
        entry = pushTabNetworkEntry(tabId, {
          request_id: requestId,
          url: redactNetworkUrl(res.url),
          method: "GET",
          resource_type: protocolString(eventParams?.type, 64),
          status: null,
          mime_type: "",
          request_headers: Object.create(null),
          response_headers: Object.create(null),
          failed: false,
          error_text: "",
          encoded_data_length: null,
        });
        byRequestId.set(requestId, entry);
      }
      if (typeof res.status === "number") entry.status = res.status;
      if (res.mimeType) entry.mime_type = protocolString(res.mimeType, 128);
      if (res.url && !entry.url) entry.url = redactNetworkUrl(res.url);
      entry.response_headers = redactNetworkHeaders(res.headers);
      return;
    }
    const existing = byRequestId.get(requestId);
    if (!existing) return;
    if (method === "Network.loadingFinished" && typeof eventParams?.encodedDataLength === "number") {
      existing.encoded_data_length = eventParams.encodedDataLength;
    } else if (method === "Network.loadingFailed") {
      existing.failed = true;
      existing.error_text = bounded(eventParams?.errorText || "loading_failed", 200);
    }
  }

  async function resolveNetworkLogTabId(rawTabId) {
    if (rawTabId !== undefined && rawTabId !== null) {
      if (!Number.isSafeInteger(rawTabId) || rawTabId < 1) throw new Error("tabId is invalid");
      return rawTabId;
    }
    if (typeof chrome?.tabs?.query === "function") {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const active = Array.isArray(tabs) ? tabs[0] : null;
      if (Number.isSafeInteger(active?.id) && active.id >= 1) return active.id;
    }
    throw new Error("tabId is invalid");
  }

  async function waitWithAbort(waitMs, tabId, state) {
    if (waitMs <= 0 || typeof globalThis.setTimeout !== "function") return;
    await new Promise((resolveWait) => {
      let settled = false;
      let cancelCheckTimer = null;
      let detachApi = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (cancelCheckTimer !== null && typeof globalThis.clearInterval === "function") {
          globalThis.clearInterval(cancelCheckTimer);
        }
        if (detachApi) detachApi.removeListener(onDetach);
        resolveWait();
      };
      const onDetach = (source) => {
        if (source?.tabId === tabId) finish();
      };
      if (typeof chrome !== "undefined" && chrome?.debugger?.onDetach && typeof chrome.debugger.onDetach.addListener === "function") {
        detachApi = chrome.debugger.onDetach;
        detachApi.addListener(onDetach);
      }
      if (state && typeof globalThis.setInterval === "function" && waitMs > 50) {
        cancelCheckTimer = globalThis.setInterval(() => {
          if (state.cancelled) finish();
        }, 50);
      }
      globalThis.setTimeout(finish, waitMs);
    });
  }

  async function networkLog(tabIdOrParams = {}, maybeOptions = {}, maybeState = null) {
    const isNumericTarget = typeof tabIdOrParams === "number";
    const options = isNumericTarget ? (maybeOptions || {}) : (tabIdOrParams || {});
    const state = isNumericTarget ? maybeState : maybeOptions;
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("DevTools networkLog options are invalid");
    }
    const rawTabId = isNumericTarget ? tabIdOrParams : (options.tabId !== undefined ? options.tabId : options.tab_id);
    const tabId = await resolveNetworkLogTabId(rawTabId);
    const clear = exactBoolean(options.clear, "clear", false);
    const limit = exactBoundedInteger(options.limit, "limit", 50, 1, MAX_NETWORK_ENTRIES);
    const explicitWait = options.waitMs !== undefined ? options.waitMs : options.wait_ms;
    const waitMs = exactBoundedInteger(explicitWait, "wait_ms", clear ? 0 : 250, 0, 5000);
    const urlPrefix = options.urlPrefix !== undefined ? options.urlPrefix : options.url_prefix;
    if (urlPrefix !== undefined) {
      if (typeof urlPrefix !== "string" || urlPrefix.length > 2048 || urlPrefix.includes("\u0000")) {
        throw new Error("url_prefix must be a bounded string");
      }
    }
    const statusMin = options.statusMin ?? options.status_min;
    if (statusMin !== undefined && (!Number.isSafeInteger(statusMin) || statusMin < 100 || statusMin > 599)) {
      throw new Error("status_min must be an integer from 100 to 599");
    }
    throwIfCancelled(state);
    if (clear) networkLogsByTab.delete(tabId);

    const session = globalThis.__machineBridgeDevtoolsSession;
    if (!session?.run) throw new Error("DevTools session module is unavailable");
    const byRequestId = new Map();
    if (!clear || waitMs > 0) {
      await session.run(tabId, async ({ send }) => {
        throwIfCancelled(state);
        const onEvent = (source, method, eventParams) => {
          if (source?.tabId !== tabId) return;
          recordCdpNetworkEvent(tabId, byRequestId, method, eventParams);
        };
        const eventApi = typeof chrome !== "undefined" ? chrome?.debugger?.onEvent : null;
        if (eventApi && typeof eventApi.addListener === "function") eventApi.addListener(onEvent);
        try {
          await send("Network.enable");
          throwIfCancelled(state);
          await waitWithAbort(waitMs, tabId, state);
          throwIfCancelled(state);
        } finally {
          if (eventApi && typeof eventApi.removeListener === "function") eventApi.removeListener(onEvent);
        }
      }, { beforeAttach: () => throwIfCancelled(state) });
    }

    const buffer = networkLogsByTab.get(tabId) || [];
    const matched = buffer.filter((entry) => {
      if (urlPrefix && !entry.url.startsWith(urlPrefix)) return false;
      if (statusMin !== undefined && (typeof entry.status !== "number" || entry.status < statusMin)) return false;
      return true;
    });
    const entries = matched.slice(-limit);
    return {
      tab_id: tabId,
      total_buffered: buffer.length,
      returned: entries.length,
      truncated: matched.length > entries.length,
      cleared: clear,
      entries,
    };
  }

  function throwIfCancelled(state) {
    if (state?.cancelled) throw new Error("browser request cancelled");
  }

  Object.defineProperty(globalThis, "__machineBridgeDevtoolsObservation", {
    value: Object.freeze({ capture, geometryByBackendNode, flattenFrameTree, networkLog }),
    configurable: false,
  });
})();
