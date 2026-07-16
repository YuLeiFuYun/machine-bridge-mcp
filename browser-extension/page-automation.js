(() => {
  if (globalThis.__machineBridgePageAutomation) return;

  const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[role],[contenteditable]:not([contenteditable='false']),summary";
  const MAX_SHADOW_ROOTS = 200;
  const MAX_SCAN_NODES = 100000;
  const MAX_QUERY_MATCHES = 10001;
  const MAX_PAGE_FIELD_CHARS = 2000;
  const MAX_PAGE_URL_CHARS = 8192;
  const MAX_WAIT_TEXT_CHARS = 2 * 1024 * 1024;
  const MAX_ELEMENT_REFS = 10000;
  const elementRefs = new WeakMap();
  const refElements = new Map();
  let nextRef = 1;
  let evictedRefs = 0;

  function scanPageElements(maxNodes = MAX_SCAN_NODES) {
    const roots = [document];
    const seenRoots = new Set(roots);
    const entries = [];
    let visitedNodes = 0;
    let truncated = false;
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      const elements = [];
      const source = iterateElements(root);
      for (const element of source) {
        if (visitedNodes >= maxNodes) {
          truncated = true;
          break;
        }
        visitedNodes += 1;
        elements.push(element);
        if (element.shadowRoot && !seenRoots.has(element.shadowRoot)) {
          if (roots.length >= MAX_SHADOW_ROOTS + 1) truncated = true;
          else {
            seenRoots.add(element.shadowRoot);
            roots.push(element.shadowRoot);
          }
        }
      }
      entries.push({ root, elements });
      if (visitedNodes >= maxNodes) break;
    }
    return { roots, entries, visitedNodes, truncated };
  }

  function iterateElements(root) {
    if (typeof document.createTreeWalker === "function") {
      const walker = document.createTreeWalker(root, globalThis.NodeFilter?.SHOW_ELEMENT || 1);
      return {
        [Symbol.iterator]() {
          return {
            next() {
              const value = walker.nextNode();
              return value ? { value, done: false } : { value: undefined, done: true };
            },
          };
        },
      };
    }
    return root.querySelectorAll("*");
  }

  function deepQuerySelectorAll(selector, limit = MAX_QUERY_MATCHES) {
    if (!selector || limit < 1) return [];
    const scan = scanPageElements();
    const results = [];
    try {
      if (typeof document.documentElement?.matches === "function") document.documentElement.matches(selector);
      for (const entry of scan.entries) {
        for (const element of entry.elements) {
          if (element.matches?.(selector)) {
            results.push(element);
            if (results.length >= limit) return results;
          }
        }
      }
    } catch (error) {
      throw new Error(`invalid CSS selector: ${String(error?.message || error).slice(0, 300)}`);
    }
    return results;
  }

  function isInteractiveElement(element) {
    const tag = String(element.tagName || "").toLowerCase();
    return ["a", "button", "input", "select", "textarea", "summary"].includes(tag)
      || element.hasAttribute?.("role")
      || (element.hasAttribute?.("contenteditable") && String(element.getAttribute?.("contenteditable") || "").toLowerCase() !== "false");
  }

  function rootById(element, id) {
    const root = element.getRootNode?.();
    if (root && typeof root.getElementById === "function") return root.getElementById(id);
    return document.getElementById(id);
  }

  function refFor(element) {
    let ref = elementRefs.get(element);
    if (!ref) {
      ref = `e${nextRef++}`;
      elementRefs.set(element, ref);
    }
    rememberRef(ref, element);
    return ref;
  }

  function rememberRef(ref, element) {
    if (refElements.has(ref)) refElements.delete(ref);
    while (refElements.size >= MAX_ELEMENT_REFS) {
      const oldest = refElements.keys().next().value;
      if (!oldest) break;
      refElements.delete(oldest);
      evictedRefs += 1;
    }
    refElements.set(ref, element);
  }

  function pruneDetachedRefs() {
    for (const [ref, element] of refElements) {
      if (!element?.isConnected) refElements.delete(ref);
    }
  }

  function inspect(params) {
    pruneDetachedRefs();
    const maxElements = Math.max(0, Number(params.maxElements) || 0);
    const includeValues = params.includeValues === true;
    const scan = scanPageElements();
    const candidates = [];
    let interactiveCount = 0;
    let formCount = 0;
    for (const entry of scan.entries) {
      for (const element of entry.elements) {
        if (String(element.tagName || "").toLowerCase() === "form") formCount += 1;
        if (!isInteractiveElement(element)) continue;
        interactiveCount += 1;
        if (candidates.length < maxElements) candidates.push(element);
      }
    }
    const describedElements = candidates.map((element, index) => describeElement(element, index, includeValues));
    return {
      snapshot_version: 2,
      document: {
        title: boundedPageText(document.title, 1000),
        url: safePageUrl(location.href),
        language: boundedPageText(document.documentElement.lang, 100),
        ready_state: document.readyState,
        forms: formCount,
        open_shadow_roots: Math.max(0, scan.roots.length - 1),
        scanned_nodes: scan.visitedNodes,
        scan_limit: MAX_SCAN_NODES,
        scan_truncated: scan.truncated,
        tracked_refs: refElements.size,
        ref_limit: MAX_ELEMENT_REFS,
        refs_evicted: evictedRefs,
      },
      elements: describedElements,
      truncated: scan.truncated || interactiveCount > describedElements.length,
    };
  }

  async function prepareAction(params) {
    const element = await prepareElementForAction(params);
    const result = actionTarget(element);
    return { ok: true, element: describeElement(element, 0, false), point: result.point };
  }

  async function action(params) {
    const element = await prepareElementForAction(params);
    await applyOne(element, params.action, params.value, params.key);
    return { ok: true, element: describeElement(element, 0, false), input_mode: "dom" };
  }

  async function prepareElementForAction(params) {
    const timeoutMs = Number(params.elementTimeoutMs) || 10000;
    const element = await waitForActionable(params.selector, params.action, timeoutMs);
    if (["press", "type_text", "focus"].includes(params.action)) element.focus();
    if (["click", "double_click", "hover"].includes(params.action)) {
      scrollElementIntoView(element);
      await waitForStableBox(element, timeoutMs);
      await waitForPointerTarget(element, timeoutMs);
    } else if (params.action === "scroll_into_view") {
      scrollElementIntoView(element);
    }
    return element;
  }

  async function fillForm(params) {
    const results = [];
    const timeoutMs = Number(params.elementTimeoutMs) || 10000;
    for (let index = 0; index < params.fields.length; index += 1) {
      const field = params.fields[index];
      try {
        const element = await waitForActionable(field.selector, field.action, timeoutMs);
        await applyOne(element, field.action, field.value, "");
        results.push({ index, action: field.action, sensitive: field.sensitive === true, element: describeElement(element, index, false) });
      } catch (error) {
        const prefix = index > 0
          ? `form field ${index} (${field.action}) failed after ${index} earlier field(s) may have changed`
          : `form field 0 (${field.action}) failed before any earlier field changed`;
        throw new Error(`${prefix}: ${boundedPageText(error?.message || error, 500)}`);
      }
    }
    if (params.submit) {
      try {
        const submitter = params.submitSelector ? await waitForActionable(params.submitSelector, "click", timeoutMs) : deepQuerySelectorAll("button[type='submit'],input[type='submit']", 1)[0];
        if (submitter) submitter.click();
        else {
          const field = params.fields.length ? findOne(params.fields[0].selector) : null;
          const form = field?.form || field?.closest?.("form") || deepQuerySelectorAll("form", 1)[0];
          if (!form) throw new Error("no form or submit control found");
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      } catch (error) {
        throw new Error(`form submission failed after ${results.length} field(s) changed: ${boundedPageText(error?.message || error, 500)}`);
      }
    }
    return { ok: true, fields: results, submitted: params.submit === true, values_exposed: false };
  }

  async function uploadFiles(params) {
    const input = await waitForActionable(params.selector, "upload", Number(params.elementTimeoutMs) || 10000);
    if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("matched element is not a file input");
    const transfer = new DataTransfer();
    for (const item of params.files) {
      const binary = atob(item.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], item.filename, { type: item.mime || "application/octet-stream" }));
    }
    input.files = transfer.files;
    dispatchValueEvents(input);
    return { ok: true, file_count: transfer.files.length, element: describeElement(input, 0, false), values_exposed: false };
  }

  function checkWait(params) {
    const elements = params.selector ? findElements(params.selector, { allowStaleRef: true }) : [];
    const visible = elements.filter(isVisible);
    const enabled = elements.filter(isEnabled);
    const editable = elements.filter(isEditable);
    const stateMatched = !params.state
      || (params.state === "attached" && elements.length > 0)
      || (params.state === "detached" && elements.length === 0)
      || (params.state === "visible" && visible.length > 0)
      || (params.state === "hidden" && visible.length === 0)
      || (params.state === "enabled" && enabled.length > 0)
      || (params.state === "editable" && editable.length > 0)
      || (params.state === "checked" && elements.some((element) => "checked" in element && element.checked === true))
      || (params.state === "unchecked" && elements.some((element) => "checked" in element && element.checked === false));
    const textSearch = params.text ? pageContainsText(params.text) : { found: true, truncated: false, scanned_chars: 0 };
    const textMatched = textSearch.found;
    const loadMatched = !params.loadState
      || (params.loadState === "domcontentloaded" && ["interactive", "complete"].includes(document.readyState))
      || (params.loadState === "complete" && document.readyState === "complete");
    return {
      matched: stateMatched && textMatched && loadMatched,
      selector_count: elements.length,
      visible_count: visible.length,
      state: params.state || "",
      text_found: textMatched,
      text_scan_truncated: textSearch.truncated,
      text_scanned_chars: textSearch.scanned_chars,
      ready_state: document.readyState,
    };
  }

  function describeElement(element, index, includeValues) {
    const tag = String(element.tagName || "").toLowerCase();
    const type = boundedPageText(element.getAttribute("type"), 100).toLowerCase();
    const sensitive = isSensitiveElement(element, tag, type);
    const visible = isVisible(element);
    const item = {
      ref: refFor(element),
      index,
      tag,
      type,
      role: boundedPageText(element.getAttribute("role") || implicitRole(element), 200),
      name: accessibleName(element),
      id: boundedPageText(element.id, MAX_PAGE_FIELD_CHARS),
      field_name: boundedPageText(element.getAttribute("name"), MAX_PAGE_FIELD_CHARS),
      label: labelText(element),
      placeholder: boundedPageText(element.getAttribute("placeholder"), MAX_PAGE_FIELD_CHARS),
      visible,
      enabled: isEnabled(element),
      editable: isEditable(element),
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: tag === "select" ? boundedPageText(element.value, MAX_PAGE_FIELD_CHARS) : null,
      href: tag === "a" ? safePageUrl(element.href) : "",
      sensitive,
      in_shadow_dom: element.getRootNode?.() instanceof ShadowRoot,
      bounding_box: visible ? boundingBox(element) : null,
    };
    if (includeValues && !sensitive && "value" in element) item.value = boundedPageText(element.value, MAX_PAGE_FIELD_CHARS);
    return item;
  }

  function isSensitiveElement(element, tag, type) {
    if (tag !== "input" && tag !== "textarea" && !element.isContentEditable) return false;
    if (["password", "hidden"].includes(type)) return true;
    const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
    if (/(?:password|one-time-code|cc-number|cc-csc|cc-exp)/.test(autocomplete)) return true;
    const identity = [element.id, element.getAttribute("name"), element.getAttribute("aria-label"), element.getAttribute("placeholder")]
      .map((value) => boundedPageText(value, 500))
      .join(" ")
      .toLowerCase();
    return /(?:password|passwd|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification|cvc|cvv|security[-_ ]?code|card[-_ ]?number)/.test(identity);
  }

  async function waitForActionable(selector, actionName, timeoutMs) {
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    const startedAt = performance.now();
    let lastProblem = "no element matched selector";
    while (performance.now() - startedAt <= boundedTimeoutMs) {
      const element = findOne(selector);
      if (!element && selector?.ref) throw new Error("element reference is stale; inspect the page again");
      if (element) {
        lastProblem = actionabilityProblem(element, actionName);
        if (!lastProblem) return element;
      }
      await delay(100);
    }
    throw new Error(`element was not actionable before timeout: ${lastProblem}`);
  }

  function actionabilityProblem(element, actionName) {
    if (!element.isConnected) return "element is detached";
    if (actionName === "upload") return isEnabled(element) ? "" : "file input is disabled";
    if (actionName === "scroll_into_view") return "";
    if (!isVisible(element)) return "element is not visible";
    if (["click", "double_click", "hover", "fill", "type_text", "select", "check", "uncheck", "press", "submit"].includes(actionName) && !isEnabled(element)) return "element is disabled";
    if (["fill", "type_text"].includes(actionName) && !isEditable(element)) return "element is not editable";
    if (actionName === "select" && !(element instanceof HTMLSelectElement)) return "element is not a select control";
    if (["check", "uncheck"].includes(actionName) && !("checked" in element)) return "element is not checkable";
    return "";
  }

  async function waitForStableBox(element, timeoutMs) {
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    const startedAt = performance.now();
    let previous = boundingBox(element);
    while (performance.now() - startedAt <= boundedTimeoutMs) {
      await delay(50);
      const current = boundingBox(element);
      if (current && previous && boxDistance(previous, current) <= 0.5) return current;
      previous = current;
    }
    throw new Error("element did not become geometrically stable before timeout");
  }

  async function waitForPointerTarget(element, timeoutMs) {
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    const startedAt = performance.now();
    let lastProblem = "element does not receive pointer events";
    while (performance.now() - startedAt <= boundedTimeoutMs) {
      const point = actionTarget(element).point;
      if (!point) lastProblem = "element has no usable viewport box";
      else if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) lastProblem = "element is outside the viewport";
      else if (receivesPointerEvents(element, point)) return;
      else lastProblem = "element is obscured by another element";
      await delay(100);
    }
    throw new Error(`element was not clickable before timeout: ${lastProblem}`);
  }

  function receivesPointerEvents(element, point) {
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit) return false;
    if (hit === element || element.contains?.(hit)) return true;
    const surfaces = targetSurfaces(element);
    return surfaces.slice(1).some((host) => host === hit);
  }

  function targetSurfaces(element) {
    const surfaces = [element];
    let root = element.getRootNode?.();
    while (root instanceof ShadowRoot) {
      surfaces.push(root.host);
      root = root.host.getRootNode?.();
    }
    return surfaces;
  }

  function scrollElementIntoView(element) {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  }

  function actionTarget(element) {
    const box = boundingBox(element);
    if (!box) return { point: null };
    const viewportWidth = Number(globalThis.innerWidth);
    const viewportHeight = Number(globalThis.innerHeight);
    const left = Math.max(0, box.x);
    const top = Math.max(0, box.y);
    const right = Math.min(Number.isFinite(viewportWidth) ? viewportWidth : box.x + box.width, box.x + box.width);
    const bottom = Math.min(Number.isFinite(viewportHeight) ? viewportHeight : box.y + box.height, box.y + box.height);
    if (right <= left || bottom <= top) return { point: null };
    return { point: { x: left + (right - left) / 2, y: top + (bottom - top) / 2 } };
  }

  async function applyOne(element, operation, value, key) {
    if (!["click", "double_click", "hover", "scroll_into_view"].includes(operation)) scrollElementIntoView(element);
    if (operation === "click") { element.click(); return; }
    if (operation === "double_click") {
      element.click();
      element.click();
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, detail: 2 }));
      return;
    }
    if (operation === "hover") { dispatchHoverEvents(element); return; }
    if (operation === "focus") { element.focus(); return; }
    if (operation === "scroll_into_view") return;
    if (operation === "submit") {
      const form = element.form || element.closest("form");
      if (!form) throw new Error("matched element is not associated with a form");
      if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
      return;
    }
    if (operation === "check" || operation === "uncheck") {
      const wanted = operation === "check";
      if (Boolean(element.checked) !== wanted) element.click();
      if (Boolean(element.checked) !== wanted) throw new Error(`checkable control did not reach the requested ${wanted ? "checked" : "unchecked"} state`);
      return;
    }
    if (operation === "select") {
      const text = String(value ?? "");
      const option = [...element.options].find((item) => item.value === text || item.text.trim() === text);
      if (!option) throw new Error("select option was not found");
      setNativeValue(element, option.value);
      dispatchValueEvents(element);
      return;
    }
    if (operation === "fill") {
      element.focus();
      if (element.isContentEditable) element.textContent = String(value ?? "");
      else setNativeValue(element, String(value ?? ""));
      dispatchValueEvents(element);
      return;
    }
    if (operation === "type_text") {
      element.focus();
      const text = String(value ?? "");
      if (element.isContentEditable) element.textContent = `${element.textContent || ""}${text}`;
      else if (typeof element.setRangeText === "function" && Number.isInteger(element.selectionStart) && Number.isInteger(element.selectionEnd)) {
        element.setRangeText(text, element.selectionStart, element.selectionEnd, "end");
      } else setNativeValue(element, `${String(element.value || "")}${text}`);
      dispatchValueEvents(element);
      return;
    }
    if (operation === "press") {
      const event = keyboardEventInit(key || value || "Enter");
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { ...event, bubbles: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { ...event, bubbles: true, composed: true }));
      return;
    }
    throw new Error(`unsupported element action: ${operation}`);
  }

  function keyboardEventInit(value) {
    const parts = String(value || "Enter").split("+").map((part) => part.trim()).filter(Boolean);
    const rawKey = parts.pop() || "Enter";
    const modifiers = new Set(parts.map((part) => part === "Ctrl" ? "Control" : part === "Cmd" || part === "Command" ? "Meta" : part));
    return {
      key: rawKey === "Space" ? " " : rawKey,
      altKey: modifiers.has("Alt"),
      ctrlKey: modifiers.has("Control"),
      metaKey: modifiers.has("Meta"),
      shiftKey: modifiers.has("Shift"),
    };
  }

  function dispatchHoverEvents(element) {
    const options = { bubbles: true, composed: true };
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerover", options));
      element.dispatchEvent(new PointerEvent("pointerenter", { ...options, bubbles: false }));
      element.dispatchEvent(new PointerEvent("pointermove", options));
    }
    element.dispatchEvent(new MouseEvent("mouseover", options));
    element.dispatchEvent(new MouseEvent("mouseenter", { ...options, bubbles: false }));
    element.dispatchEvent(new MouseEvent("mousemove", options));
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchValueEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function findOne(selector) {
    const elements = findElements(selector);
    if (!elements.length) return null;
    if (elements.length > 1 && !Number.isInteger(selector.index)) throw new Error(`selector matched ${elements.length} elements; use ref or index to disambiguate`);
    return elements[0];
  }

  function findElements(selector, { allowStaleRef = false } = {}) {
    if (selector.ref) {
      const element = refElements.get(String(selector.ref));
      if (!element) return [];
      if (!element.isConnected) {
        if (allowStaleRef) return [];
        throw new Error("element reference is stale; inspect the page again");
      }
      return [element];
    }
    let elements = [];
    try {
      if (selector.css) elements = deepQuerySelectorAll(selector.css);
      else if (selector.id) elements = deepQuerySelectorAll(`[id="${cssEscape(selector.id)}"]`);
      else elements = deepQuerySelectorAll(INTERACTIVE_SELECTOR);
    } catch (error) {
      throw new Error(`invalid CSS selector: ${String(error?.message || error).slice(0, 300)}`);
    }
    elements = elements.filter((element) => {
      if (selector.name && element.getAttribute("name") !== selector.name) return false;
      if (selector.label && !sameText(labelText(element), selector.label)) return false;
      if (selector.text && !sameText(boundedNodeText(element, MAX_PAGE_FIELD_CHARS + 1), selector.text)) return false;
      if (selector.role && !sameText(element.getAttribute("role") || implicitRole(element), selector.role)) return false;
      if (selector.placeholder && !sameText(element.getAttribute("placeholder") || "", selector.placeholder)) return false;
      return true;
    });
    if (Number.isInteger(selector.index)) return elements[selector.index] ? [elements[selector.index]] : [];
    return elements;
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (!element.getClientRects || element.getClientRects().length > 0);
  }

  function isEnabled(element) {
    if (element.matches?.(":disabled")) return false;
    if (element.disabled) return false;
    return String(element.getAttribute("aria-disabled") || "").toLowerCase() !== "true"
      && !element.closest?.('[aria-disabled="true"]');
  }

  function isEditable(element) {
    if (!isEnabled(element)) return false;
    if (element.isContentEditable) return true;
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
    if (element.readOnly) return false;
    const type = String(element.type || "text").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }

  function boundingBox(element) {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }

  function boxDistance(left, right) {
    return Math.max(
      Math.abs(left.x - right.x), Math.abs(left.y - right.y),
      Math.abs(left.width - right.width), Math.abs(left.height - right.height),
    );
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function normalizedText(value) {
    return boundedPageText(value, MAX_WAIT_TEXT_CHARS).trim().replace(/\s+/g, " ").toLowerCase();
  }

  function sameText(left, right) {
    return normalizedText(left) === normalizedText(right);
  }

  function labelText(element) {
    if (element.labels?.length) {
      let text = "";
      for (const label of [...element.labels].slice(0, 100)) {
        text += ` ${boundedNodeText(label, Math.max(0, MAX_PAGE_FIELD_CHARS - text.length))}`;
        if (text.length >= MAX_PAGE_FIELD_CHARS) break;
      }
      return boundedPageText(text.trim(), MAX_PAGE_FIELD_CHARS);
    }
    const parent = element.closest?.("label");
    if (parent) return boundedNodeText(parent, MAX_PAGE_FIELD_CHARS);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      let text = "";
      for (const id of labelledBy.split(/\s+/).slice(0, 100)) {
        const labelled = rootById(element, id);
        text += ` ${boundedNodeText(labelled, Math.max(0, MAX_PAGE_FIELD_CHARS - text.length))}`;
        if (text.length >= MAX_PAGE_FIELD_CHARS) break;
      }
      return boundedPageText(text.trim(), MAX_PAGE_FIELD_CHARS);
    }
    return "";
  }

  function accessibleName(element) {
    const direct = element.getAttribute("aria-label") || labelText(element) || element.getAttribute("title") || element.getAttribute("alt");
    return boundedPageText(direct || boundedNodeText(element, 500), 500).trim().replace(/\s+/g, " ");
  }

  function boundedNodeText(node, maxChars) {
    const limit = Math.max(0, Number(maxChars) || 0);
    if (!node || limit === 0) return "";
    if (typeof document.createTreeWalker !== "function") return boundedPageText(node.textContent || node.innerText, limit);
    const walker = document.createTreeWalker(node, globalThis.NodeFilter?.SHOW_TEXT || 4);
    let text = "";
    let current;
    while ((current = walker.nextNode()) && text.length < limit) {
      const remaining = limit - text.length;
      text += boundedPageText(current.data, remaining);
    }
    return text;
  }

  function pageContainsText(value) {
    const needle = normalizedText(value);
    if (!needle) return { found: true, truncated: false, scanned_chars: 0 };
    const root = document.body || document.documentElement;
    if (!root) return { found: false, truncated: false, scanned_chars: 0 };
    if (typeof document.createTreeWalker !== "function") {
      const text = boundedPageText(root.textContent || root.innerText, MAX_WAIT_TEXT_CHARS);
      return { found: normalizedText(text).includes(needle), truncated: String(root.textContent || root.innerText || "").length > text.length, scanned_chars: text.length };
    }
    const walker = document.createTreeWalker(root, globalThis.NodeFilter?.SHOW_TEXT || 4);
    let haystack = "";
    let truncated = false;
    let scannedChars = 0;
    let node;
    while ((node = walker.nextNode())) {
      const remaining = MAX_WAIT_TEXT_CHARS - scannedChars;
      if (remaining <= 0) { truncated = true; break; }
      const raw = String(node.data || "");
      const boundedRaw = raw.slice(0, remaining);
      scannedChars += boundedRaw.length;
      const chunk = normalizedText(boundedRaw);
      if (chunk) {
        haystack = haystack ? `${haystack} ${chunk}` : chunk;
        if (haystack.includes(needle)) return { found: true, truncated: raw.length > boundedRaw.length, scanned_chars: scannedChars };
        if (haystack.length > needle.length * 2 + 4096) haystack = haystack.slice(-(needle.length + 4096));
      }
      if (raw.length > boundedRaw.length) { truncated = true; break; }
    }
    return { found: haystack.includes(needle), truncated, scanned_chars: Math.min(MAX_WAIT_TEXT_CHARS, scannedChars) };
  }

  function boundedPageText(value, maxChars) {
    return String(value || "").slice(0, Math.max(0, maxChars));
  }

  function safePageUrl(value) {
    const text = boundedPageText(value, MAX_PAGE_URL_CHARS);
    try {
      const parsed = new URL(text, location.href);
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
      }
      return boundedPageText(parsed.href, MAX_PAGE_URL_CHARS);
    } catch {
      return text;
    }
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = String(element.type || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  }

  function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  Object.defineProperty(globalThis, "__machineBridgePageAutomation", {
    value: Object.freeze({ inspect, prepareAction, action, fillForm, uploadFiles, checkWait }),
    configurable: true,
  });
})();
