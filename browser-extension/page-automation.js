(() => {
  if (globalThis.__machineBridgePageAutomation) return;

  const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[role],[contenteditable='true'],summary";
  const MAX_SHADOW_ROOTS = 200;
  const elementRefs = new WeakMap();
  const refElements = new Map();
  let nextRef = 1;

  function collectRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length && roots.length <= MAX_SHADOW_ROOTS; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
        if (roots.length > MAX_SHADOW_ROOTS) break;
      }
    }
    return roots;
  }

  function deepQuerySelectorAll(selector) {
    const results = [];
    for (const root of collectRoots()) results.push(...root.querySelectorAll(selector));
    return results;
  }

  function rootById(element, id) {
    const root = element.getRootNode?.();
    if (root && typeof root.getElementById === "function") return root.getElementById(id);
    return document.getElementById(id);
  }

  function refFor(element) {
    let ref = elementRefs.get(element);
    if (ref) {
      refElements.set(ref, element);
      return ref;
    }
    ref = `e${nextRef++}`;
    elementRefs.set(element, ref);
    refElements.set(ref, element);
    return ref;
  }

  function pruneDetachedRefs() {
    for (const [ref, element] of refElements) {
      if (!element?.isConnected) refElements.delete(ref);
    }
  }

  function inspect(params) {
    pruneDetachedRefs();
    const maxElements = Number(params.maxElements) || 300;
    const includeValues = params.includeValues === true;
    const all = deepQuerySelectorAll(INTERACTIVE_SELECTOR);
    const candidates = all.slice(0, maxElements);
    return {
      snapshot_version: 1,
      document: {
        title: document.title,
        url: location.href,
        language: document.documentElement.lang || "",
        ready_state: document.readyState,
        forms: deepQuerySelectorAll("form").length,
        open_shadow_roots: Math.max(0, collectRoots().length - 1),
      },
      elements: candidates.map((element, index) => describeElement(element, index, includeValues)),
      truncated: all.length > candidates.length,
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
      const element = await waitForActionable(field.selector, field.action, timeoutMs);
      await applyOne(element, field.action, field.value, "");
      results.push({ index, action: field.action, sensitive: field.sensitive === true, element: describeElement(element, index, false) });
    }
    if (params.submit) {
      const submitter = params.submitSelector ? await waitForActionable(params.submitSelector, "click", timeoutMs) : deepQuerySelectorAll("button[type='submit'],input[type='submit']")[0];
      if (submitter) submitter.click();
      else {
        const field = params.fields.length ? findOne(params.fields[0].selector) : null;
        const form = field?.form || field?.closest?.("form") || deepQuerySelectorAll("form")[0];
        if (!form) throw new Error("no form or submit control found");
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
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
    const pageText = params.text ? normalizedText(document.body?.innerText || document.body?.textContent || "") : "";
    const textMatched = !params.text || pageText.includes(normalizedText(params.text));
    const loadMatched = !params.loadState
      || (params.loadState === "domcontentloaded" && ["interactive", "complete"].includes(document.readyState))
      || (params.loadState === "complete" && document.readyState === "complete");
    return {
      matched: stateMatched && textMatched && loadMatched,
      selector_count: elements.length,
      visible_count: visible.length,
      state: params.state || "",
      text_found: textMatched,
      ready_state: document.readyState,
    };
  }

  function describeElement(element, index, includeValues) {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const sensitive = isSensitiveElement(element, tag, type);
    const visible = isVisible(element);
    const item = {
      ref: refFor(element),
      index,
      tag,
      type,
      role: element.getAttribute("role") || implicitRole(element),
      name: accessibleName(element),
      id: element.id || "",
      field_name: element.getAttribute("name") || "",
      label: labelText(element),
      placeholder: element.getAttribute("placeholder") || "",
      visible,
      enabled: isEnabled(element),
      editable: isEditable(element),
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: tag === "select" ? element.value : null,
      href: tag === "a" ? element.href : "",
      sensitive,
      in_shadow_dom: element.getRootNode?.() instanceof ShadowRoot,
      bounding_box: visible ? boundingBox(element) : null,
    };
    if (includeValues && !sensitive && "value" in element) item.value = String(element.value || "").slice(0, 2000);
    return item;
  }

  function isSensitiveElement(element, tag, type) {
    if (tag !== "input" && tag !== "textarea") return false;
    if (["password", "hidden"].includes(type)) return true;
    const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
    if (/(?:password|one-time-code|cc-number|cc-csc|cc-exp)/.test(autocomplete)) return true;
    const identity = `${element.id || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`.toLowerCase();
    return /(?:password|passwd|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification|cvc|cvv|security[-_ ]?code|card[-_ ]?number)/.test(identity);
  }

  async function waitForActionable(selector, actionName, timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let lastProblem = "no element matched selector";
    while (Date.now() <= deadline) {
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
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let previous = boundingBox(element);
    while (Date.now() <= deadline) {
      await delay(50);
      const current = boundingBox(element);
      if (current && previous && boxDistance(previous, current) <= 0.5) return current;
      previous = current;
    }
    throw new Error("element did not become geometrically stable before timeout");
  }

  async function waitForPointerTarget(element, timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let lastProblem = "element does not receive pointer events";
    while (Date.now() <= deadline) {
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
      return;
    }
    if (operation === "select") {
      const text = String(value ?? "");
      const option = [...element.options].find((item) => item.value === text || item.text.trim() === text);
      if (!option) throw new Error("select option was not found");
      element.value = option.value;
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
      if (selector.text && !sameText(element.innerText || element.textContent || "", selector.text)) return false;
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
    if (!left || !right) return Number.POSITIVE_INFINITY;
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
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function sameText(left, right) {
    return normalizedText(left) === normalizedText(right);
  }

  function labelText(element) {
    if (element.labels?.length) return [...element.labels].map((label) => label.innerText || label.textContent || "").join(" ").trim();
    const parent = element.closest("label");
    if (parent) return (parent.innerText || parent.textContent || "").trim();
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) return labelledBy.split(/\s+/).map((id) => rootById(element, id)?.textContent || "").join(" ").trim();
    return "";
  }

  function accessibleName(element) {
    return (element.getAttribute("aria-label") || labelText(element) || element.getAttribute("title") || element.getAttribute("alt") || element.innerText || element.textContent || "")
      .trim().replace(/\s+/g, " ").slice(0, 500);
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  Object.defineProperty(globalThis, "__machineBridgePageAutomation", {
    value: Object.freeze({ inspect, prepareAction, action, fillForm, uploadFiles, checkWait }),
    configurable: true,
  });
})();
