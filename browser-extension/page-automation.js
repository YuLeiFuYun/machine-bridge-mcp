(() => {
  if (globalThis.__machineBridgePageAutomation) return;

  const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[role],[contenteditable='true'],summary";
  const MAX_SHADOW_ROOTS = 200;

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

  function inspect(params) {
    const maxElements = Number(params.maxElements) || 300;
    const includeValues = params.includeValues === true;
    const all = deepQuerySelectorAll(INTERACTIVE_SELECTOR);
    const candidates = all.slice(0, maxElements);
    return {
      document: {
        title: document.title,
        url: location.href,
        language: document.documentElement.lang || "",
        forms: deepQuerySelectorAll("form").length,
        open_shadow_roots: Math.max(0, collectRoots().length - 1),
      },
      elements: candidates.map((element, index) => describeElement(element, index, includeValues)),
      truncated: all.length > candidates.length,
    };
  }

  function action(params) {
    const element = findElement(params.selector);
    if (!element) throw new Error("no element matched selector");
    applyOne(element, params.action, params.value, params.key);
    return { ok: true, element: describeElement(element, 0, false) };
  }

  function fillForm(params) {
    const results = [];
    for (let index = 0; index < params.fields.length; index += 1) {
      const field = params.fields[index];
      const element = findElement(field.selector);
      if (!element) throw new Error(`no element matched fields[${index}] selector`);
      applyOne(element, field.action, field.value, "");
      results.push({ index, action: field.action, sensitive: field.sensitive === true, element: describeElement(element, index, false) });
    }
    if (params.submit) {
      const submitter = params.submitSelector ? findElement(params.submitSelector) : deepQuerySelectorAll("button[type='submit'],input[type='submit']")[0];
      if (submitter) submitter.click();
      else {
        const field = params.fields.length ? findElement(params.fields[0].selector) : null;
        const form = field?.form || field?.closest?.("form") || deepQuerySelectorAll("form")[0];
        if (!form) throw new Error("no form or submit control found");
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      }
    }
    return { ok: true, fields: results, submitted: params.submit === true, values_exposed: false };
  }

  function uploadFiles(params) {
    const input = findElement(params.selector);
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
    return { ok: true, file_count: transfer.files.length, values_exposed: false };
  }

  function describeElement(element, index, includeValues) {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const sensitive = isSensitiveElement(element, tag, type);
    const item = {
      index,
      tag,
      type,
      role: element.getAttribute("role") || implicitRole(element),
      name: accessibleName(element),
      id: element.id || "",
      field_name: element.getAttribute("name") || "",
      label: labelText(element),
      placeholder: element.getAttribute("placeholder") || "",
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: tag === "select" ? element.value : null,
      href: tag === "a" ? element.href : "",
      sensitive,
      in_shadow_dom: element.getRootNode?.() instanceof ShadowRoot,
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

  function applyOne(element, operation, value, key) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    if (operation === "click") { element.click(); return; }
    if (operation === "focus") { element.focus(); return; }
    if (operation === "submit") {
      const form = element.form || element.closest("form");
      if (!form) throw new Error("matched element is not associated with a form");
      if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
      return;
    }
    if (operation === "check" || operation === "uncheck") {
      if (!("checked" in element)) throw new Error("matched element is not checkable");
      const wanted = operation === "check";
      if (Boolean(element.checked) !== wanted) element.click();
      return;
    }
    if (operation === "select") {
      if (!(element instanceof HTMLSelectElement)) throw new Error("matched element is not a select control");
      const text = String(value ?? "");
      const option = [...element.options].find((item) => item.value === text || item.text.trim() === text);
      if (!option) throw new Error("select option was not found");
      element.value = option.value;
      dispatchValueEvents(element);
      return;
    }
    if (operation === "fill") {
      if (!("value" in element) && !element.isContentEditable) throw new Error("matched element is not editable");
      element.focus();
      if (element.isContentEditable) element.textContent = String(value ?? "");
      else setNativeValue(element, String(value ?? ""));
      dispatchValueEvents(element);
      return;
    }
    if (operation === "press") {
      const pressed = String(key || value || "Enter");
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, bubbles: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: pressed, bubbles: true, composed: true }));
      return;
    }
    throw new Error(`unsupported element action: ${operation}`);
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

  function findElement(selector) {
    let elements = [];
    if (selector.css) elements = deepQuerySelectorAll(selector.css);
    else if (selector.id) elements = deepQuerySelectorAll(`[id="${cssEscape(selector.id)}"]`);
    else elements = deepQuerySelectorAll(INTERACTIVE_SELECTOR);
    elements = elements.filter((element) => {
      if (selector.name && element.getAttribute("name") !== selector.name) return false;
      if (selector.label && !sameText(labelText(element), selector.label)) return false;
      if (selector.text && !sameText(element.innerText || element.textContent || "", selector.text)) return false;
      if (selector.role && !sameText(element.getAttribute("role") || implicitRole(element), selector.role)) return false;
      if (selector.placeholder && !sameText(element.getAttribute("placeholder") || "", selector.placeholder)) return false;
      return true;
    });
    return elements[Number.isInteger(selector.index) ? selector.index : 0] || null;
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function sameText(left, right) {
    return String(left || "").trim().replace(/\s+/g, " ").toLowerCase() === String(right || "").trim().replace(/\s+/g, " ").toLowerCase();
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

  Object.defineProperty(globalThis, "__machineBridgePageAutomation", {
    value: Object.freeze({ inspect, action, fillForm, uploadFiles }),
    configurable: true,
  });
})();
