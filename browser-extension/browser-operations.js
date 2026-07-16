(() => {
  if (globalThis.__machineBridgeBrowserOperations) return;

  const MAX_ACCESSIBLE_FRAMES = 64;

  async function dispatch(method, params, state) {
    if (method === "list_tabs") return listTabs(params);
    if (method === "manage_tabs") return manageTabs(params);
    if (method === "wait") return browserWait(params, state);
    if (method === "get_source") return getSource(params, state);
    if (method === "inspect_page") return inspectPage(params, state);
    if (method === "action") return browserAction(params, state);
    if (method === "fill_form") return fillForm(params, state);
    if (method === "upload_files") return uploadFiles(params);
    if (method === "screenshot") return screenshot(params);
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
  
  
  async function manageTabs(params) {
    if (params.action === "new") {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: params.active !== false });
      return { action: "new", ...publicTab(tab) };
    }
    const tab = await chrome.tabs.get(params.tabId);
    if (params.action === "activate") {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { action: "activate", ...publicTab(await chrome.tabs.get(tab.id)) };
    }
    if (params.action === "close") {
      const result = { action: "close", closed: true, ...publicTab(tab) };
      await chrome.tabs.remove(tab.id);
      return result;
    }
    throw new Error("unsupported browser tab action");
  }
  
  async function browserWait(params, state) {
    const tab = await resolveTab(params.tabId);
    const timeoutMs = Math.max(1, Number(params.timeoutMs) || 30000);
    const startedAt = performance.now();
    let last = null;
    while (performance.now() - startedAt <= timeoutMs) {
      throwIfCancelled(state);
      const current = await chrome.tabs.get(tab.id);
      const urlMatched = !params.urlContains || String(current.url || "").includes(params.urlContains);
      const needsPage = Boolean(params.selector || params.text || params.loadState);
      let page = { matched: true, ready_state: current.status || "" };
      if (needsPage) {
        try {
          assertPageTab(current);
          const [execution] = await executePageAutomation(scriptTarget(current.id, params.frameId, false), "checkWait", params);
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
    if (Number.isInteger(frameId)) return { tabId, frameIds: [frameId] };
    if (allFrames) return { tabId, allFrames: true };
    return { tabId };
  }
  
  async function resolveTab(tabId) {
    if (Number.isInteger(tabId)) return chrome.tabs.get(tabId);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active browser tab");
    return tab;
  }
  
  async function getSource(params, state) {
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const maxBytes = Math.max(1, Number(params.maxBytes) || 1024 * 1024);
    const selection = await discoverPageFrames(tab.id, params.frameId, params.allFrames === true);
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
      const returnedBytes = Math.max(0, Math.min(frameBudget, Number(result.returned_bytes ?? result.bytes) || 0));
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
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const maxElements = Math.max(1, Number(params.maxElements) || 300);
    const selection = await discoverPageFrames(tab.id, params.frameId, params.allFrames === true, maxElements);
    let remainingElements = maxElements;
    const frames = [];
    for (let index = 0; index < selection.frames.length && remainingElements > 0; index += 1) {
      throwIfCancelled(state);
      const remainingFrames = selection.frames.length - index;
      const frameBudget = Math.max(1, Math.floor(remainingElements / remainingFrames));
      const [execution] = await executePageAutomation(
        { tabId: tab.id, frameIds: [selection.frames[index].frameId] },
        "inspect",
        { maxElements: frameBudget, includeValues: params.includeValues === true },
      );
      const result = execution?.result || { elements: [], truncated: true };
      const used = Math.min(frameBudget, Array.isArray(result.elements) ? result.elements.length : 0);
      remainingElements -= used;
      frames.push({ frame_id: execution?.frameId ?? selection.frames[index].frameId, ...result });
    }
    return {
      tab_id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      frames,
      total_elements: maxElements - remainingElements,
      max_elements: maxElements,
      frames_truncated: selection.truncated,
    };
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
    const limit = Math.max(1, Math.min(MAX_ACCESSIBLE_FRAMES, Number(resultBudget) || 1));
    return { frames: ordered.slice(0, limit), truncated: ordered.length > limit };
  }
  
  function boundedDocumentSource(limit) {
    const maxBytes = Math.max(1, Number(limit) || 1);
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
  
  async function browserAction(params, state) {
    const tab = await resolveTab(params.tabId);
    if (params.action === "navigate") {
      if (!params.url) throw new Error("navigate requires url");
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        const updated = await chrome.tabs.update(tab.id, { url: params.url });
        await waiter.promise;
        return publicTab(await chrome.tabs.get(updated.id));
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    if (params.action === "reload") {
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        await chrome.tabs.reload(tab.id);
        await waiter.promise;
        return publicTab(await chrome.tabs.get(tab.id));
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    if (params.action === "back" || params.action === "forward") {
      const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
      try {
        if (params.action === "back") await chrome.tabs.goBack(tab.id);
        else await chrome.tabs.goForward(tab.id);
        await waiter.promise;
        return publicTab(await chrome.tabs.get(tab.id));
      } catch (error) {
        waiter.cancel();
        throw error;
      }
    }
    assertPageTab(tab);
    const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
    let result;
    try {
      result = await performPageAction(tab, params);
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    const current = await chrome.tabs.get(tab.id).catch(() => tab);
    return { tab_id: current.id, title: current.title || "", url: current.url || "", ...result };
  }
  
  async function performPageAction(tab, params) {
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
      const [prepared] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "prepareAction", params);
      try {
        const api = globalThis.__machineBridgeDevtoolsInput;
        if (!api?.perform) {
          const unavailable = new Error("trusted input module is unavailable");
          Object.defineProperty(unavailable, "safeToFallback", { value: true });
          throw unavailable;
        }
        await api.perform(tab.id, params.action, {
          point: prepared.result?.point,
          key: params.key || params.value || "Enter",
          text: params.value || "",
        });
        return { ...prepared.result, input_mode: "trusted", trusted_input_fallback: false };
      } catch (error) {
        if (params.inputMode === "trusted") throw error;
        if (error?.safeToFallback !== true) {
          const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 500);
          throw new Error(`trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying. (${detail})`);
        }
        const [fallback] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "action", params);
        return {
          ...fallback.result,
          input_mode: "dom",
          trusted_input_fallback: true,
          fallback_reason: String(error?.message || error).slice(0, 500),
        };
      }
    }
    const [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "action", params);
    return { ...execution.result, input_mode: "dom", trusted_input_fallback: false };
  }
  async function fillForm(params, state) {
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const waiter = beginTabWait(tab.id, params.waitFor, state?.timeoutMs, state);
    let execution;
    try {
      [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "fillForm", params);
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      throw error;
    }
    return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", ...execution.result };
  }
  
  async function uploadFiles(params) {
    const tab = await resolveTab(params.tabId);
    assertPageTab(tab);
    const [execution] = await executePageAutomation(scriptTarget(tab.id, params.frameId, false), "uploadFiles", params);
    return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", ...execution.result };
  }
  
  async function screenshot(params) {
    const tab = await resolveTab(params.tabId);
    const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const changedActiveTab = previousActive?.id !== tab.id;
    if (changedActiveTab) await chrome.tabs.update(tab.id, { active: true });
    try {
      const data = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: params.format === "jpeg" ? "jpeg" : "png",
        quality: Number(params.quality) || 90,
      });
      return { tab_id: tab.id, title: tab.title || "", url: tab.url || "", data };
    } finally {
      if (changedActiveTab && previousActive?.id) {
        const [currentActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
        if (currentActive?.id === tab.id) await chrome.tabs.update(previousActive.id, { active: true }).catch(() => {});
      }
    }
  }
  
  function publicTab(tab) {
    return { tab_id: tab.id, window_id: tab.windowId, title: tab.title || "", url: tab.url || "", status: tab.status || "" };
  }
  
  function assertPageTab(tab) {
    const url = String(tab.url || "");
    if (!/^(https?|file):/i.test(url)) throw new Error("this page cannot be scripted by a browser extension");
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
    const timeout = Number(value);
    if (!Number.isFinite(timeout)) return 30000;
    return Math.max(1000, Math.min(185000, Math.floor(timeout)));
  }

  function throwIfCancelled(state) {
    if (state?.cancelled) throw new Error("browser request cancelled");
  }

  Object.defineProperty(globalThis, "__machineBridgeBrowserOperations", {
    value: Object.freeze({ dispatch, boundedRequestTimeout, boundedDocumentSource }),
    configurable: false,
  });
})();
