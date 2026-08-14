(() => {
  const PAGE_AUTOMATION_VERSION = 4;
  if (globalThis.__machineBridgePageAutomation?.version === PAGE_AUTOMATION_VERSION) return;

  const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[role],[contenteditable]:not([contenteditable='false']),summary";
  const MAX_SHADOW_ROOTS = 200;
  const MAX_SCAN_NODES = 100000;
  const MAX_QUERY_MATCHES = 10001;
  const MAX_PAGE_FIELD_CHARS = 2000;
  const MAX_PAGE_URL_CHARS = 8192;
  const MAX_WAIT_TEXT_CHARS = 2 * 1024 * 1024;
  const MAX_ELEMENT_REFS = 10000;
  const PAGE_ACTIONS = new Set([
    "click", "double_click", "hover", "fill", "type_text", "select", "check", "uncheck", "focus", "press", "submit", "scroll_into_view",
  ]);
  const FORM_ACTIONS = new Set(["fill", "select", "check", "uncheck", "click"]);
  const SELECTOR_FIELDS = new Set(["ref", "css", "id", "name", "label", "text", "role", "placeholder", "index"]);
  const SNAPSHOT_IDENTITY_BOOLEAN_FIELDS = new Set(["sensitive", "in_shadow_dom"]);
  const SNAPSHOT_IDENTITY_FIELDS = new Set([
    "tag", "type", "role", "name", "id", "field_name", "label", "placeholder", "href", "sensitive", "in_shadow_dom",
  ]);
  const DOCUMENT_EPOCH = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
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

  function normalizedFocusQuery(value) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.length > 1000 || value.includes("\0")) throw new Error("browser inspection focusQuery is invalid");
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function inspectBoolean(value, label, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`browser inspection ${label} is invalid`);
    return value;
  }

  function focusMatchScore(element, focusQuery) {
    if (!focusQuery) return 0;
    const identity = [
      element.getAttribute?.("aria-label"), element.getAttribute?.("title"), element.getAttribute?.("placeholder"),
      element.getAttribute?.("name"), element.id, boundedNodeText(element, 500), element.getAttribute?.("role"),
    ].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ");
    if (identity === focusQuery) return 240;
    if (identity.includes(focusQuery)) return 180;
    const tokens = focusQuery.split(" ").filter((token) => token.length > 1);
    return Math.min(120, tokens.filter((token) => identity.includes(token)).length * 30);
  }

  function elementSalience(element, focusQuery) {
    let score = 0;
    const tag = String(element.tagName || "").toLowerCase();
    if (["button", "input", "select", "textarea", "a", "summary"].includes(tag)) score += 20;
    if (element === document.activeElement || element.focused === true) score += 80;
    if (element.disabled === true || String(element.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") score -= 40;
    const rect = safeBoundingRect(element);
    if (rect && rect.width > 0 && rect.height > 0) {
      score += 20;
      if (rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < Number(globalThis.innerWidth) && rect.y < Number(globalThis.innerHeight)) score += 50;
    }
    if (Number(element.tabIndex) >= 0) score += 10;
    score += focusMatchScore(element, focusQuery);
    return score;
  }

  function safeBoundingRect(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
      return rect;
    } catch { return null; }
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
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser inspection payload is invalid");
    const maxElements = params.maxElements === undefined ? 0 : params.maxElements;
    if (!Number.isSafeInteger(maxElements) || maxElements < 0) throw new Error("browser inspection maxElements is invalid");
    const includeValues = inspectBoolean(params.includeValues, "includeValues", false);
    const includePrivateHistory = inspectBoolean(params.includePrivateHistory, "includePrivateHistory", false);
    const focusQuery = normalizedFocusQuery(params.focusQuery);
    const scan = scanPageElements();
    const candidates = [];
    let interactiveCount = 0;
    let formCount = 0;
    let sourceIndex = 0;
    for (const entry of scan.entries) {
      for (const element of entry.elements) {
        if (String(element.tagName || "").toLowerCase() === "form") formCount += 1;
        if (!isInteractiveElement(element)) { sourceIndex += 1; continue; }
        interactiveCount += 1;
        candidates.push({ element, score: elementSalience(element, focusQuery), focusScore: focusMatchScore(element, focusQuery), sourceIndex });
        sourceIndex += 1;
      }
    }
    candidates.sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex);
    const selected = candidates.slice(0, maxElements);
    const queryMatches = focusQuery ? candidates.filter((candidate) => candidate.focusScore > 0) : [];
    const describedElements = selected.map(({ element, score, focusScore }, index) => ({
      ...describeElement(element, index, includeValues),
      salience_score: Math.round(score),
      ...(focusQuery ? { focus_match_score: Math.round(focusScore) } : {}),
    }));
    return {
      snapshot_version: 3,
      document: {
        epoch: DOCUMENT_EPOCH,
        ...(includePrivateHistory ? { _machine_history_entry_key: historyEntryKey() } : {}),
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
        selection_strategy: focusQuery ? "salience+focus_query" : "salience",
        focus_query_applied: Boolean(focusQuery),
        focus_query_matched: focusQuery ? queryMatches.length > 0 : null,
        focus_query_match_count: focusQuery ? queryMatches.length : null,
        focus_query_search_exhaustive: focusQuery ? scan.truncated !== true : null,
      },
      elements: describedElements,
      truncated: scan.truncated || interactiveCount > describedElements.length,
    };
  }

  function historyEntryKey() {
    try {
      const value = globalThis.navigation?.currentEntry?.key;
      return typeof value === "string" && value && !value.includes("\0") ? value.slice(0, 512) : "";
    } catch { return ""; }
  }

  function documentState() {
    const viewport = globalThis.visualViewport;
    return {
      epoch: DOCUMENT_EPOCH,
      _machine_history_entry_key: historyEntryKey(),
      title: boundedPageText(document.title, 1000),
      url: safePageUrl(location.href),
      ready_state: document.readyState,
      viewport: {
        width: finiteNumber(viewport?.width, finiteNumber(globalThis.innerWidth, 0)),
        height: finiteNumber(viewport?.height, finiteNumber(globalThis.innerHeight, 0)),
        offset_left: finiteNumber(viewport?.offsetLeft, 0),
        offset_top: finiteNumber(viewport?.offsetTop, 0),
        scale: finiteNumber(viewport?.scale, 1),
        scroll_x: finiteNumber(globalThis.scrollX, 0),
        scroll_y: finiteNumber(globalThis.scrollY, 0),
        device_pixel_ratio: finiteNumber(globalThis.devicePixelRatio, 1),
      },
    };
  }

  function exactOptionalAuthorityString(value, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
      throw new Error("snapshot authority string is invalid before dispatch");
    }
    return value;
  }

  function historyAction(params) {
    const action = exactOptionalAuthorityString(params?.action, 32);
    if (!["reload", "back", "forward"].includes(action)) throw new Error("history action is invalid before dispatch");
    const expectedUrl = exactOptionalAuthorityString(params?.expectedTabUrl, 32768);
    const expectedDocument = exactOptionalAuthorityString(params?.expectedDocumentEpoch, 9000);
    const expectedHistoryEntry = exactOptionalAuthorityString(params?.expectedHistoryEntryKey, 512);
    const currentUrl = safePageUrl(location.href);
    if (expectedUrl && currentUrl !== expectedUrl) {
      throw new Error("snapshot browser tab changed before navigation dispatch; observe again");
    }
    if (expectedDocument && DOCUMENT_EPOCH !== expectedDocument) {
      throw new Error("snapshot history document changed before dispatch; observe again");
    }
    if (expectedHistoryEntry) {
      const currentHistoryEntry = historyEntryKey();
      if (!currentHistoryEntry) throw new Error("snapshot history entry could not be verified before dispatch; observe again");
      if (currentHistoryEntry !== expectedHistoryEntry) throw new Error("snapshot history entry changed before dispatch; observe again");
    }
    const navigation = globalThis.navigation;
    if (action === "back" && navigation?.canGoBack !== true) {
      throw new Error("snapshot browser history has no back entry before dispatch; observe again");
    }
    if (action === "forward" && navigation?.canGoForward !== true) {
      throw new Error("snapshot browser history has no forward entry before dispatch; observe again");
    }
    const mutate = action === "reload" ? navigation?.reload : action === "back" ? navigation?.back : navigation?.forward;
    if (typeof mutate !== "function") throw new Error("snapshot history mutation API is unavailable before dispatch; observe again");
    try { mutate.call(navigation); }
    catch {
      throw new Error("browser action may have been dispatched; the action outcome is unknown because the renderer history mutation API failed. Inspect the page before retrying.");
    }
    return { dispatched: true };
  }

  function refIdentity(params) {
    const ref = params?.ref;
    if (typeof ref !== "string" || !ref || ref.length > 100 || ref.includes("\0")) throw new Error("element reference is invalid");
    const elements = findElements({ ref }, { allowStaleRef: true });
    const element = elements.length === 1 ? elements[0] : null;
    return {
      attached: Boolean(element),
      matched: Boolean(element && snapshotIdentityMatches(element, params?.expectedIdentity)),
    };
  }

  function pointProbe(params) {
    const x = exactFiniteNumber(params?.x);
    const y = exactFiniteNumber(params?.y);
    const width = exactPositiveFiniteNumber(globalThis.innerWidth);
    const height = exactPositiveFiniteNumber(globalThis.innerHeight);
    if (x === null || y === null || width === null || height === null || x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error("visual point is outside the current viewport");
    }
    const raw = document.elementFromPoint(x, y);
    if (!raw) return { point: { x, y }, hit: null };
    const target = isInteractiveElement(raw) ? raw : raw.closest?.(INTERACTIVE_SELECTOR) || raw;
    return { point: { x, y }, hit: describeElement(target, 0, false), raw_tag: String(raw.tagName || "").toLowerCase() };
  }

  function exactFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }

  function exactPositiveFiniteNumber(value) {
    const number = exactFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  function exactElementTimeoutMs(value) {
    if (value === undefined) return 10000;
    if (!Number.isSafeInteger(value) || value < 1 || value > 120000) throw new Error("element timeout is invalid before dispatch");
    return value;
  }

  function requiredMutationText(value, label, maxLength = 131072) {
    if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) {
      throw new Error(`${label} must be a string of at most ${maxLength} characters without NUL bytes before dispatch`);
    }
    return value;
  }

  function validatePageSelector(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selector must be an object before dispatch");
    const output = {};
    for (const key of Object.keys(value)) if (!SELECTOR_FIELDS.has(key)) throw new Error(`unknown selector field before dispatch: ${key}`);
    for (const key of ["ref", "css", "id", "name", "label", "text", "role", "placeholder"]) {
      if (!Object.hasOwn(value, key)) continue;
      const maxLength = key === "ref" ? 100 : 2000;
      output[key] = requiredMutationText(value[key], `selector.${key}`, maxLength);
    }
    if (Object.hasOwn(value, "index")) {
      if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index > 10000) throw new Error("selector.index must be an integer from 0 to 10000 before dispatch");
      output.index = value.index;
    }
    if (!Object.keys(output).length) throw new Error("selector requires at least one field before dispatch");
    if (output.ref !== undefined && Object.keys(output).length !== 1) throw new Error("selector.ref cannot be combined with other fields before dispatch");
    return output;
  }

  function validateExpectedIdentity(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot identity must be an object before dispatch");
    const output = {};
    for (const [field, expected] of Object.entries(value)) {
      if (!SNAPSHOT_IDENTITY_FIELDS.has(field)) throw new Error(`unknown snapshot identity field before dispatch: ${field}`);
      if (SNAPSHOT_IDENTITY_BOOLEAN_FIELDS.has(field)) {
        if (typeof expected !== "boolean") throw new Error(`snapshot identity ${field} must be boolean before dispatch`);
        output[field] = expected;
      } else {
        output[field] = requiredMutationText(expected, `snapshot identity ${field}`, field === "href" ? 8192 : 2000);
      }
    }
    return output;
  }

  function requiredPageAction(value) {
    if (typeof value !== "string" || !PAGE_ACTIONS.has(value)) throw new Error("page action is invalid before dispatch");
    return value;
  }

  function validateActionPayload(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("page action payload is invalid before dispatch");
    const allowed = new Set(["action", "selector", "value", "key", "elementTimeoutMs", "expectedIdentity"]);
    for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`unknown page action property before dispatch: ${key}`);
    const action = requiredPageAction(params.action);
    const selector = validatePageSelector(params.selector);
    const timeoutMs = exactElementTimeoutMs(params.elementTimeoutMs);
    const expectedIdentity = validateExpectedIdentity(params.expectedIdentity);
    let value = params.value;
    let key = params.key;
    if (["fill", "select", "type_text"].includes(action)) {
      value = requiredMutationText(value, "value");
      if (key !== undefined && key !== "") throw new Error("key is not valid for this page action before dispatch");
    } else if (action === "press") {
      if (value !== undefined && value !== null) value = requiredMutationText(value, "value", 100);
      if (key !== undefined && key !== "") key = requiredMutationText(key, "key", 100);
      keyboardEventInit(key || value || "Enter");
    } else {
      if (value !== undefined && value !== null) throw new Error("value is not valid for this page action before dispatch");
      if (key !== undefined && key !== "") throw new Error("key is not valid for this page action before dispatch");
    }
    return { action, selector, timeoutMs, expectedIdentity, value, key };
  }

  function rendererUtf8ByteLength(value) {
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

  function rendererDecodedBase64Bytes(value) {
    if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding;
  }

  function validateFormPayload(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("form payload is invalid before dispatch");
    if (!Array.isArray(params.fields) || params.fields.length < 1 || params.fields.length > 200) throw new Error("form fields are invalid before dispatch");
    if (typeof params.submit !== "boolean") throw new Error("form submit must be boolean before dispatch");
    const timeoutMs = exactElementTimeoutMs(params.elementTimeoutMs);
    const submitSelector = params.submitSelector === undefined || params.submitSelector === null ? null : validatePageSelector(params.submitSelector);
    let totalValueBytes = 0;
    const fields = params.fields.map((field, index) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`form field ${index} is invalid before dispatch`);
      for (const key of Object.keys(field)) if (!["selector", "action", "value", "sensitive"].includes(key)) throw new Error(`unknown form field ${index} property before dispatch: ${key}`);
      if (typeof field.action !== "string" || !FORM_ACTIONS.has(field.action)) throw new Error(`form field ${index} action is invalid before dispatch`);
      if (typeof field.sensitive !== "boolean") throw new Error(`form field ${index} sensitive flag must be boolean before dispatch`);
      const selector = validatePageSelector(field.selector);
      let value = field.value;
      if (["fill", "select"].includes(field.action)) {
        value = requiredMutationText(value, `form field ${index} value`);
        totalValueBytes += rendererUtf8ByteLength(value);
        if (totalValueBytes > 4 * 1024 * 1024) throw new Error("form values exceed the 4 MiB aggregate budget before dispatch");
      }
      else if (value !== undefined && value !== null) throw new Error(`form field ${index} value is not valid before dispatch`);
      return { selector, action: field.action, value, sensitive: field.sensitive };
    });
    return { fields, submit: params.submit, submitSelector, timeoutMs };
  }

  function validateUploadPayload(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("upload payload is invalid before dispatch");
    const selector = validatePageSelector(params.selector);
    const timeoutMs = exactElementTimeoutMs(params.elementTimeoutMs);
    if (!Array.isArray(params.files) || params.files.length < 1 || params.files.length > 8) throw new Error("upload files are invalid before dispatch");
    let totalBytes = 0;
    const files = params.files.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`upload file ${index} is invalid before dispatch`);
      const filename = requiredMutationText(item.filename, `upload file ${index} filename`, 255);
      if (!filename || filename === "." || filename === ".." || /[\/\\\u0000-\u001f\u007f]/.test(filename)) throw new Error(`upload file ${index} filename is invalid before dispatch`);
      const mime = requiredMutationText(item.mime, `upload file ${index} mime`, 200);
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) throw new Error(`upload file ${index} mime is invalid before dispatch`);
      const data = requiredMutationText(item.data, `upload file ${index} data`, 8 * 1024 * 1024);
      const bytes = rendererDecodedBase64Bytes(data);
      if (bytes === null) throw new Error(`upload file ${index} data is invalid before dispatch`);
      totalBytes += bytes;
      if (totalBytes > 5 * 1024 * 1024) throw new Error("upload files exceed the 5 MiB aggregate budget before dispatch");
      return { filename, mime, data };
    });
    return { selector, timeoutMs, files };
  }

  async function prepareAction(params) {
    const element = await prepareElementForAction(params);
    try {
      const result = actionTarget(element);
      return { ok: true, element: describeElement(element, 0, false), point: result.point };
    } catch (error) {
      throw domMutationUnknown(params.action, error);
    }
  }

  async function action(params) {
    const prepared = validateActionPayload(params);
    const element = await waitForActionable(prepared.selector, prepared.action, prepared.timeoutMs);
    assertSnapshotIdentity(element, prepared.expectedIdentity);
    const mutationStarted = await applyOne(element, prepared.action, prepared.value, prepared.key, prepared.timeoutMs);
    try {
      return { ok: true, element: describeElement(element, 0, false), input_mode: "dom" };
    } catch (error) {
      if (mutationStarted) throw domMutationUnknown(prepared.action, error);
      throw error;
    }
  }

  async function prepareElementForAction(params) {
    const prepared = validateActionPayload(params);
    const element = await waitForActionable(prepared.selector, prepared.action, prepared.timeoutMs);
    assertSnapshotIdentity(element, prepared.expectedIdentity);
    let mutationStarted = false;
    try {
      if (["press", "type_text", "focus"].includes(prepared.action)) {
        mutationStarted = true;
        element.focus();
      }
      if (["click", "double_click", "hover"].includes(prepared.action)) {
        mutationStarted = true;
        scrollElementIntoView(element);
        await waitForStableBox(element, prepared.timeoutMs);
        await waitForPointerTarget(element, prepared.timeoutMs);
      } else if (prepared.action === "scroll_into_view") {
        mutationStarted = true;
        scrollElementIntoView(element);
      }
    } catch (error) {
      if (mutationStarted) throw domMutationUnknown(prepared.action, error);
      throw error;
    }
    return element;
  }

  async function fillForm(params) {
    const prepared = validateFormPayload(params);
    const results = [];
    const timeoutMs = prepared.timeoutMs;
    for (let index = 0; index < prepared.fields.length; index += 1) {
      const field = prepared.fields[index];
      try {
        const element = await waitForActionable(field.selector, field.action, timeoutMs);
        const mutationStarted = await applyOne(element, field.action, field.value, "", timeoutMs);
        let description;
        try { description = describeElement(element, index, false); }
        catch (error) { if (mutationStarted) throw domMutationUnknown("fill_form", error); throw error; }
        results.push({ index, action: field.action, sensitive: field.sensitive === true, element: description });
      } catch (error) {
        if (index > 0 || String(error?.message || error).includes("outcome is unknown")) {
          throw domMutationUnknown("fill_form", error);
        }
        const prefix = index > 0
          ? `form field ${index} (${field.action}) failed after ${index} earlier field(s) may have changed`
          : `form field 0 (${field.action}) failed before any earlier field changed`;
        throw new Error(`${prefix}: ${boundedPageText(error?.message || error, 500)}`);
      }
    }
    if (prepared.submit) {
      let submissionStarted = false;
      try {
        const submitter = prepared.submitSelector ? await waitForActionable(prepared.submitSelector, "click", timeoutMs) : deepQuerySelectorAll("button[type='submit'],input[type='submit']", 1)[0];
        if (submitter) {
          submissionStarted = true;
          submitter.click();
        }
        else {
          const field = prepared.fields.length ? findOne(prepared.fields[0].selector) : null;
          const form = field?.form || field?.closest?.("form") || deepQuerySelectorAll("form", 1)[0];
          if (!form) throw new Error("no form or submit control found");
          submissionStarted = true;
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      } catch (error) {
        if (submissionStarted || results.length > 0) throw domMutationUnknown("form_submission", error);
        throw new Error(`form submission failed after ${results.length} field(s) changed: ${boundedPageText(error?.message || error, 500)}`);
      }
    }
    return { ok: true, fields: results, submitted: prepared.submit, values_exposed: false };
  }

  async function uploadFiles(params) {
    const prepared = validateUploadPayload(params);
    const input = await waitForActionable(prepared.selector, "upload", prepared.timeoutMs);
    if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("matched element is not a file input");
    const transfer = new DataTransfer();
    for (const item of prepared.files) {
      const binary = atob(item.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], item.filename, { type: item.mime || "application/octet-stream" }));
    }
    try {
      input.files = transfer.files;
      dispatchValueEvents(input);
      return { ok: true, file_count: transfer.files.length, element: describeElement(input, 0, false), values_exposed: false };
    } catch (error) {
      throw domMutationUnknown("upload_files", error);
    }
  }

  function validateWaitPayload(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("browser wait payload is invalid");
    const allowed = new Set(["selector", "state", "text", "loadState"]);
    for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`unknown browser wait property: ${key}`);
    const selector = params.selector === undefined || params.selector === null ? null : validatePageSelector(params.selector);
    const state = exactWaitString(params.state, "state", 32);
    if (state && !["attached", "detached", "visible", "hidden", "enabled", "editable", "checked", "unchecked"].includes(state)) throw new Error("browser wait state is invalid");
    if (state && !selector) throw new Error("browser wait state requires selector");
    const text = exactWaitString(params.text, "text", 4000);
    const loadState = exactWaitString(params.loadState, "loadState", 32);
    if (loadState && !["domcontentloaded", "complete"].includes(loadState)) throw new Error("browser wait loadState is invalid");
    if (!selector && !text && !loadState) throw new Error("browser wait payload requires a page condition");
    return { selector, state, text, loadState };
  }

  function exactWaitString(value, label, maxLength) {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`browser wait ${label} is invalid`);
    return value;
  }

  function checkWait(params) {
    const prepared = validateWaitPayload(params);
    const elements = prepared.selector ? findElements(prepared.selector, { allowStaleRef: true }) : [];
    const visible = elements.filter(isVisible);
    const enabled = elements.filter(isEnabled);
    const editable = elements.filter(isEditable);
    const stateMatched = !prepared.state
      || (prepared.state === "attached" && elements.length > 0)
      || (prepared.state === "detached" && elements.length === 0)
      || (prepared.state === "visible" && visible.length > 0)
      || (prepared.state === "hidden" && visible.length === 0)
      || (prepared.state === "enabled" && enabled.length > 0)
      || (prepared.state === "editable" && editable.length > 0)
      || (prepared.state === "checked" && elements.some((element) => "checked" in element && element.checked === true))
      || (prepared.state === "unchecked" && elements.some((element) => "checked" in element && element.checked === false));
    const textSearch = prepared.text ? pageContainsText(prepared.text) : { found: true, truncated: false, scanned_chars: 0 };
    const textMatched = textSearch.found;
    const loadMatched = !prepared.loadState
      || (prepared.loadState === "domcontentloaded" && ["interactive", "complete"].includes(document.readyState))
      || (prepared.loadState === "complete" && document.readyState === "complete");
    return {
      matched: stateMatched && textMatched && loadMatched,
      selector_count: elements.length,
      visible_count: visible.length,
      state: prepared.state || "",
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

  function snapshotIdentityMatches(element, expected) {
    if (expected === undefined || expected === null) return true;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
    const actual = describeElement(element, 0, false);
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (!SNAPSHOT_IDENTITY_FIELDS.has(field)) return false;
      if (SNAPSHOT_IDENTITY_BOOLEAN_FIELDS.has(field)) {
        if (typeof expectedValue !== "boolean" || actual[field] !== expectedValue) return false;
        continue;
      }
      if (typeof expectedValue !== "string") return false;
      const actualValue = typeof actual[field] === "string" ? actual[field] : "";
      if (actualValue !== expectedValue) return false;
    }
    return true;
  }

  function assertSnapshotIdentity(element, expected) {
    if (!snapshotIdentityMatches(element, expected)) throw new Error("snapshot_ref_identity_changed_before_dispatch");
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
    const viewportWidth = exactPositiveFiniteNumber(globalThis.innerWidth);
    const viewportHeight = exactPositiveFiniteNumber(globalThis.innerHeight);
    if (viewportWidth === null || viewportHeight === null) throw new Error("browser viewport dimensions are unavailable before dispatch");
    const left = Math.max(0, box.x);
    const top = Math.max(0, box.y);
    const right = Math.min(viewportWidth, box.x + box.width);
    const bottom = Math.min(viewportHeight, box.y + box.height);
    if (right <= left || bottom <= top) return { point: null };
    return { point: { x: left + (right - left) / 2, y: top + (bottom - top) / 2 } };
  }

  async function applyOne(element, operation, value, key, timeoutMs = 10000) {
    const wanted = operation === "check" ? true : operation === "uncheck" ? false : null;
    if (wanted !== null && Boolean(element.checked) === wanted) return false;
    let selectedOption = null;
    if (operation === "select") {
      const text = requiredMutationText(value, "select value");
      selectedOption = [...element.options].find((item) => item.value === text || item.text.trim() === text) || null;
      if (!selectedOption) throw new Error("select option was not found");
    }
    const keyEvent = operation === "press" ? keyboardEventInit(key || value || "Enter") : null;
    let mutationStarted = false;
    try {
      if (["click", "double_click", "hover"].includes(operation)) {
        mutationStarted = true;
        scrollElementIntoView(element);
        await waitForStableBox(element, timeoutMs);
        await waitForPointerTarget(element, timeoutMs);
        if (operation === "click") element.click();
        else if (operation === "double_click") {
          element.click();
          element.click();
          element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, detail: 2 }));
        } else dispatchHoverEvents(element);
        return true;
      }
      if (operation === "focus") { mutationStarted = true; element.focus(); return true; }
      if (operation === "scroll_into_view") { mutationStarted = true; scrollElementIntoView(element); return true; }
      if (operation === "submit") {
        const form = element.form || element.closest("form");
        if (!form) throw new Error("matched element is not associated with a form");
        mutationStarted = true;
        if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit();
        return true;
      }
      if (wanted !== null) {
        mutationStarted = true;
        element.click();
        if (Boolean(element.checked) !== wanted) throw new Error(`checkable control did not reach the requested ${wanted ? "checked" : "unchecked"} state`);
        return true;
      }
      if (operation === "select") {
        mutationStarted = true;
        setNativeValue(element, selectedOption.value);
        dispatchValueEvents(element);
        return true;
      }
      if (operation === "fill") {
        const text = requiredMutationText(value, "fill value");
        mutationStarted = true;
        element.focus();
        if (element.isContentEditable) element.textContent = text;
        else setNativeValue(element, text);
        dispatchValueEvents(element);
        return true;
      }
      if (operation === "type_text") {
        const text = requiredMutationText(value, "type_text value");
        mutationStarted = true;
        element.focus();
        if (element.isContentEditable) element.textContent = `${element.textContent || ""}${text}`;
        else if (typeof element.setRangeText === "function" && Number.isInteger(element.selectionStart) && Number.isInteger(element.selectionEnd)) {
          element.setRangeText(text, element.selectionStart, element.selectionEnd, "end");
        } else setNativeValue(element, `${String(element.value || "")}${text}`);
        dispatchValueEvents(element);
        return true;
      }
      if (operation === "press") {
        mutationStarted = true;
        element.focus();
        element.dispatchEvent(new KeyboardEvent("keydown", { ...keyEvent, bubbles: true, composed: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", { ...keyEvent, bubbles: true, composed: true }));
        return true;
      }
      throw new Error(`unsupported element action: ${operation}`);
    } catch (error) {
      if (mutationStarted) throw domMutationUnknown(operation, error);
      throw error;
    }
  }

  function domMutationUnknown(operation, error) {
    const detail = boundedPageText(error?.message || error, 500).replace(/\s+/g, " ");
    return new Error(`browser action may have been dispatched; the action outcome is unknown because DOM ${operation} failed after a side-effecting step. Inspect the page before retrying.${detail ? ` (${detail})` : ""}`);
  }

  function keyboardEventInit(value) {
    const text = value === undefined || value === "" ? "Enter" : requiredMutationText(value, "key", 100);
    const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
    const rawKey = parts.pop() || "Enter";
    const modifiers = new Set();
    for (const part of parts) {
      const normalized = part === "Ctrl" ? "Control" : part === "Cmd" || part === "Command" ? "Meta" : part;
      if (!["Alt", "Control", "Meta", "Shift"].includes(normalized)) throw new Error(`unsupported key modifier: ${part}`);
      modifiers.add(normalized);
    }
    const namedKeys = new Set([
      "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
      "Home", "End", "PageUp", "PageDown", "Space",
    ]);
    if (!namedKeys.has(rawKey) && [...rawKey].length !== 1) throw new Error(`unsupported key: ${rawKey}`);
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
      if (typeof selector.ref !== "string") return [];
      const element = refElements.get(selector.ref);
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

  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function delay(ms) {
    const runtime = globalThis.chrome?.runtime;
    if (runtime && typeof runtime.sendMessage === "function") {
      const delayMs = Number.isFinite(ms) ? Math.ceil(ms) : 0;
      if (delayMs < 1 || delayMs > 250) return Promise.reject(new Error("browser action delay is invalid"));
      return Promise.resolve(runtime.sendMessage({ type: "machine_bridge_internal_delay", delay_ms: delayMs }))
        .then((response) => {
          if (response?.ok !== true) throw new Error("browser action timing service unavailable");
        });
    }
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  Object.defineProperty(globalThis, "__machineBridgePageAutomation", {
    value: Object.freeze({ version: PAGE_AUTOMATION_VERSION, inspect, documentState, historyAction, refIdentity, pointProbe, prepareAction, action, fillForm, uploadFiles, checkWait }),
    configurable: true,
  });
})();
