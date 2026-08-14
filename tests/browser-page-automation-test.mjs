import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const source = await readFile(new URL("../browser-extension/page-automation.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.id = attributes.id || "";
    this.type = attributes.type || "";
    this.value = "";
    this.disabled = false;
    this.readOnly = false;
    this.checked = false;
    this.isConnected = true;
    this.isContentEditable = false;
    this.labels = [];
    this.innerText = attributes.text || "";
    this.textContent = this.innerText;
    this.shadowRoot = null;
    this.clickCount = 0;
    this.focused = false;
    this.events = [];
    this.rect = { x: 900, y: 700, width: 120, height: 32 };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  getRootNode() { return document; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains(node) { return node === this; }
  getBoundingClientRect() { return { ...this.rect }; }
  getClientRects() { return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []; }
  checkVisibility() { return this.isConnected; }
  matches(selector) { return selector === ":disabled" ? this.disabled : false; }
  scrollIntoView(options) {
    this.scrollOptions = options;
    this.rect = { x: 40, y: 60, width: 120, height: 32 };
  }
  click() { this.clickCount += 1; if (this.type === "checkbox") this.checked = !this.checked; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event); return true; }
}
class FakeInputElement extends FakeElement {
  constructor(attributes = {}) {
    super("input", attributes);
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  setRangeText(text, start, end) {
    this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}
class FakeTextAreaElement extends FakeElement {
  constructor(attributes = {}) { super("textarea", attributes); }
}
class FakeSelectElement extends FakeElement {
  constructor(attributes = {}) { super("select", attributes); this.options = []; }
}
class FakeShadowRoot {}
class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

const button = new FakeElement("button", { id: "save", text: "Save" });
const input = new FakeInputElement({ id: "query", type: "text" });
input.rect = { x: 50, y: 100, width: 200, height: 32 };
const overlay = new FakeElement("div");
const link = new FakeElement("a", { id: "account-link", text: "Account" });
const credentialUrl = new URL("https://example.invalid/path");
credentialUrl.username = "fixture-user";
credentialUrl.password = "fixture-pass";
link.href = credentialUrl.href;
const secretEditor = new FakeElement("div", { id: "secret-editor", "aria-label": "API token", contenteditable: "true" });
secretEditor.isContentEditable = true;
secretEditor.value = "must-not-leak";
let elements = [button, input, link, secretEditor];
let overflowScan = false;
const overflowElement = new FakeElement("div");
let hit = overlay;
const historyMutations = [];
const navigation = {
  currentEntry: { key: "history-slot-1" },
  canGoBack: true,
  canGoForward: true,
  reload() { historyMutations.push("reload"); },
  back() { historyMutations.push("back"); },
  forward() { historyMutations.push("forward"); },
};
const document = {
  title: "Fixture",
  readyState: "complete",
  documentElement: { lang: "en" },
  body: { innerText: "Fixture page", textContent: "Fixture page" },
  querySelectorAll(selector) {
    if (selector === "*" && overflowScan) return {
      *[Symbol.iterator]() { for (let index = 0; index < 100001; index += 1) yield overflowElement; },
    };
    if (selector === "*") return elements;
    if (selector === "form") return [];
    if (selector.includes("button") || selector === "[id=\"save\"]") return elements;
    return [];
  },
  getElementById(id) { return id === "save" ? button : null; },
  elementFromPoint() { return hit; },
};

const context = vm.createContext({
  document,
  location: { href: "https://example.test/form" },
  navigation,
  innerWidth: 800,
  innerHeight: 600,
  getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  HTMLInputElement: FakeInputElement,
  HTMLTextAreaElement: FakeTextAreaElement,
  HTMLSelectElement: FakeSelectElement,
  ShadowRoot: FakeShadowRoot,
  Event: FakeEvent,
  MouseEvent: FakeEvent,
  KeyboardEvent: FakeEvent,
  PointerEvent: FakeEvent,
  DataTransfer: class {},
  File: class {},
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  Uint8Array,
  Date,
  URL,
  Promise,
  performance,
  setTimeout,
  clearTimeout,
  console,
});
vm.runInContext(source, context, { filename: "page-automation.js" });
const api = context.__machineBridgePageAutomation;
assert(api?.version === 4 && typeof api.inspect === "function" && typeof api.historyAction === "function",
  "page automation module did not expose its versioned fixed API");

for (const [payload, expected] of [
  [{ maxElements: "10", includeValues: false }, "maxElements is invalid"],
  [{ maxElements: [10], includeValues: false }, "maxElements is invalid"],
  [{ maxElements: 1.5, includeValues: false }, "maxElements is invalid"],
  [{ maxElements: 10, includeValues: "false" }, "includeValues is invalid"],
  [{ maxElements: 10, includeValues: false, includePrivateHistory: "true" }, "includePrivateHistory is invalid"],
  [{ maxElements: 10, includeValues: false, focusQuery: ["Save"] }, "focusQuery is invalid"],
]) await expectReject(() => api.inspect(payload), expected);

const first = api.inspect({ maxElements: 10, includeValues: false });
const second = api.inspect({ maxElements: 10, includeValues: false });
const privateHistoryInspect = api.inspect({ maxElements: 10, includeValues: false, includePrivateHistory: true });
assert(Object.hasOwn(first.document, "_machine_history_entry_key") === false,
  "ordinary page inspection exposed the private navigation history entry key");
assert(privateHistoryInspect.document._machine_history_entry_key === "history-slot-1",
  "Computer Use internal inspection did not capture the current private navigation history entry key");
const initialDocumentState = api.documentState();
assert(initialDocumentState._machine_history_entry_key === "history-slot-1",
  "internal document-state verification did not return the current navigation history entry key");
for (const action of ["reload", "back", "forward"]) {
  const before = historyMutations.length;
  const result = api.historyAction({
    action,
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  });
  assert(result.dispatched === true && historyMutations.length === before + 1 && historyMutations.at(-1) === action,
    `${action} did not revalidate and dispatch through the renderer-side Navigation API boundary`);
}
const historyDispatchBaseline = historyMutations.length;
for (const malformed of [
  { action: ["back"], expectedTabUrl: "https://example.test/form", expectedDocumentEpoch: initialDocumentState.epoch, expectedHistoryEntryKey: "history-slot-1" },
  { action: "back", expectedTabUrl: ["https://example.test/form"], expectedDocumentEpoch: initialDocumentState.epoch, expectedHistoryEntryKey: "history-slot-1" },
  { action: "back", expectedTabUrl: "https://example.test/form", expectedDocumentEpoch: [initialDocumentState.epoch], expectedHistoryEntryKey: "history-slot-1" },
  { action: "back", expectedTabUrl: "https://example.test/form", expectedDocumentEpoch: initialDocumentState.epoch, expectedHistoryEntryKey: ["history-slot-1"] },
]) {
  await expectReject(
    () => Promise.resolve().then(() => api.historyAction(malformed)),
    "snapshot authority string is invalid before dispatch",
  );
}
assert(historyMutations.length === historyDispatchBaseline,
  "coercible renderer history authority reached the Navigation API mutation boundary");
navigation.currentEntry.key = "history-slot-new";
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "back",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot history entry changed before dispatch; observe again",
);
assert(historyMutations.length === historyDispatchBaseline, "stale history entry reached the Navigation API mutation boundary");
navigation.currentEntry.key = "history-slot-1";
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "forward",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: "doc-stale",
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot history document changed before dispatch; observe again",
);
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "reload",
    expectedTabUrl: "https://example.test/other",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot browser tab changed before navigation dispatch; observe again",
);
assert(historyMutations.length === historyDispatchBaseline,
  "stale document/url evidence reached the renderer-side history mutation boundary");
navigation.canGoBack = false;
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "back",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot browser history has no back entry before dispatch; observe again",
);
navigation.canGoBack = true;
navigation.canGoForward = false;
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "forward",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot browser history has no forward entry before dispatch; observe again",
);
navigation.canGoForward = true;
assert(historyMutations.length === historyDispatchBaseline,
  "unavailable back/forward history direction reached the renderer-side mutation boundary");
const savedBack = navigation.back;
navigation.back = () => { throw new Error("synthetic renderer history mutation failure"); };
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "back",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "browser action may have been dispatched; the action outcome is unknown because the renderer history mutation API failed",
);
navigation.back = savedBack;
delete navigation.back;
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "back",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot history mutation API is unavailable before dispatch; observe again",
);
navigation.back = savedBack;
navigation.currentEntry.key = "";
await expectReject(
  () => Promise.resolve().then(() => api.historyAction({
    action: "back",
    expectedTabUrl: "https://example.test/form",
    expectedDocumentEpoch: initialDocumentState.epoch,
    expectedHistoryEntryKey: "history-slot-1",
  })),
  "snapshot history entry could not be verified before dispatch; observe again",
);
navigation.currentEntry.key = "history-slot-1";
assert(historyMutations.length === historyDispatchBaseline,
  "missing Navigation API/history evidence dispatched a snapshot-bound history mutation");
const firstButton = first.elements.find((item) => item.id === "save");
const firstInput = first.elements.find((item) => item.id === "query");
const ref = firstButton?.ref;
const inputRef = firstInput?.ref;
assert(ref && inputRef && second.elements.find((item) => item.id === "save")?.ref === ref, "element reference was not stable within the document");
const expectedButtonIdentity = { tag: "button", role: "button", name: "Save", id: "save", sensitive: false, in_shadow_dom: false };
assert(api.refIdentity({ ref, expectedIdentity: expectedButtonIdentity }).matched === true,
  "snapshot ref identity check rejected the unchanged element");
button.innerText = "Delete";
button.textContent = "Delete";
assert(api.refIdentity({ ref, expectedIdentity: expectedButtonIdentity }).matched === false,
  "snapshot ref identity check accepted a repurposed same-document element");
await expectReject(
  () => api.action({ action: "click", selector: { ref }, expectedIdentity: expectedButtonIdentity, elementTimeoutMs: 50 }),
  "snapshot_ref_identity_changed_before_dispatch",
);
assert(button.clickCount === 0 && button.scrollOptions === undefined,
  "semantic identity drift was detected only after click/scroll side effects began");
button.innerText = "Save";
button.textContent = "Save";
assert(first.snapshot_version === 3 && typeof first.document.epoch === "string" && first.document.epoch.startsWith("doc_") && first.document.scanned_nodes === elements.length, "inspection did not expose bounded scan metadata");
assert(firstButton.bounding_box.x === 900, "inspection lost element geometry");
assert(first.document.selection_strategy === "salience" && first.document.focus_query_applied === false, "inspection did not report salience selection metadata");
const focusedSelection = api.inspect({ maxElements: 1, includeValues: false, focusQuery: "Save" });
assert(focusedSelection.elements[0]?.id === "save" && focusedSelection.document.selection_strategy === "salience+focus_query", "focus query did not promote the requested control into the bounded observation");
assert(focusedSelection.elements[0].focus_match_score > 0, "focus query did not expose per-element match evidence");
assert(focusedSelection.document.focus_query_matched === true && focusedSelection.document.focus_query_match_count >= 1, "focus query did not expose scan-wide match evidence");
assert(focusedSelection.document.focus_query_search_exhaustive === true, "complete bounded page scan was not marked exhaustive for focus-query evidence");
const credentialHref = first.elements.find((item) => item.id === "account-link")?.href || "";
const inspectedUrl = new URL(credentialHref);
assert(!inspectedUrl.username && !inspectedUrl.password, "inspection exposed URL credentials");
const secretItem = first.elements.find((item) => item.id === "secret-editor");
assert(secretItem?.sensitive === true && !("value" in secretItem), "contenteditable secret value was exposed");
input.id = "x".repeat(5000);
const boundedFields = api.inspect({ maxElements: 10, includeValues: true });
assert(boundedFields.elements.find((item) => item.ref === inputRef)?.id.length === 2000, "page-controlled field metadata was not bounded");
input.id = "query";
overflowScan = true;
const overflow = api.inspect({ maxElements: 10, includeValues: false });
overflowScan = false;
assert(overflow.document.scan_truncated === true && overflow.document.scanned_nodes === 100000 && overflow.truncated === true, "DOM scan safety limit was not enforced");
const normalElements = elements;
elements = Array.from({ length: 10001 }, (_, index) => new FakeElement("button", { id: `ref-${index}`, text: `Button ${index}` }));
const refBounded = api.inspect({ maxElements: 10001, includeValues: false });
assert(refBounded.document.tracked_refs === 10000 && refBounded.document.ref_limit === 10000 && refBounded.document.refs_evicted >= 1, "stable element references were not bounded");
await expectReject(() => api.action({ action: "click", selector: { ref: refBounded.elements[0].ref }, elementTimeoutMs: 50 }), "reference is stale");
elements = normalElements;
api.inspect({ maxElements: 10, includeValues: false });

setTimeout(() => { hit = button; }, 130);
const result = await api.action({ action: "click", selector: { ref }, elementTimeoutMs: 1000 });
assert(result.input_mode === "dom" && button.clickCount === 1, "DOM click action did not complete");
assert(button.scrollOptions?.behavior === "instant", "pointer action did not force deterministic scrolling");
assert(hit === button, "pointer action did not wait for an obscuring element to clear");

const rendererSetTimeout = context.setTimeout;
const delayRequests = [];
context.chrome = {
  runtime: {
    async sendMessage(message) {
      delayRequests.push({ ...message });
      assert(message?.type === "machine_bridge_internal_delay"
        && Number.isSafeInteger(message.delay_ms)
        && message.delay_ms > 0
        && message.delay_ms <= 250,
      "page automation sent an invalid internal delay request");
      await new Promise((resolve) => { setTimeout(resolve, message.delay_ms); });
      return { ok: true };
    },
  },
};
context.setTimeout = () => { throw new Error("renderer timer must not be used for browser action geometry waits"); };
hit = button;
const throttledClickBaseline = button.clickCount;
try {
  const backgroundResult = await api.action({ action: "click", selector: { ref }, elementTimeoutMs: 1000 });
  assert(backgroundResult.input_mode === "dom" && button.clickCount === throttledClickBaseline + 1,
    "DOM click did not settle when renderer timers were unavailable");
  assert(delayRequests.some((request) => request.delay_ms === 50),
    "DOM click geometry stability did not use the extension timing service");
} finally {
  context.setTimeout = rendererSetTimeout;
  delete context.chrome;
}

const projectionButton = new FakeElement("button", { id: "projection-failure", text: "Projection" });
projectionButton.rect = { x: 120, y: 140, width: 120, height: 32 };
let projectionButtonMutated = false;
const projectionButtonGetAttribute = projectionButton.getAttribute.bind(projectionButton);
projectionButton.getAttribute = (name) => {
  if (projectionButtonMutated && name === "type") throw new Error("post-click metadata unavailable");
  return projectionButtonGetAttribute(name);
};
projectionButton.click = function() { this.clickCount += 1; projectionButtonMutated = true; };
elements.push(projectionButton);
const projectionButtonRef = api.inspect({ maxElements: 20, includeValues: false }).elements.find((item) => item.id === "projection-failure").ref;
hit = projectionButton;
await expectReject(
  () => api.action({ action: "click", selector: { ref: projectionButtonRef }, elementTimeoutMs: 500 }),
  "outcome is unknown",
);
assert(projectionButton.clickCount === 1,
  "post-click metadata failure did not preserve the completed DOM mutation while reporting uncertainty");
projectionButtonMutated = false;
elements = elements.filter((element) => element !== projectionButton);
hit = button;

input.value = "abc";
input.selectionStart = 1;
input.selectionEnd = 2;
await api.action({ action: "type_text", selector: { ref: inputRef }, value: "Z", elementTimeoutMs: 500 });
assert(input.value === "aZc" && input.selectionStart === 2, "DOM text fallback did not respect the current selection");
await api.action({ action: "press", selector: { ref: inputRef }, key: "Control+A", elementTimeoutMs: 500 });
const keydown = input.events.find((event) => event.type === "keydown");
assert(keydown?.key === "A" && keydown.ctrlKey === true, "DOM key fallback did not preserve shortcut modifiers");

button.rect = { x: -40, y: -10, width: 100, height: 40 };
button.scrollIntoView = function(options) { this.scrollOptions = options; };
hit = button;
const clipped = await api.prepareAction({ action: "click", selector: { ref }, elementTimeoutMs: 500 });
assert(clipped.point.x === 30 && clipped.point.y === 15, "trusted input point was not clipped to the visible viewport intersection");

const preparationProjection = new FakeElement("button", { id: "prepare-projection", text: "Prepare projection" });
preparationProjection.rect = { x: 140, y: 210, width: 120, height: 32 };
let preparationSideEffect = false;
const preparationGetAttribute = preparationProjection.getAttribute.bind(preparationProjection);
preparationProjection.scrollIntoView = function(options) { this.scrollOptions = options; preparationSideEffect = true; };
preparationProjection.getAttribute = (name) => {
  if (preparationSideEffect && name === "type") throw new Error("post-prepare metadata unavailable");
  return preparationGetAttribute(name);
};
elements.push(preparationProjection);
const preparationRef = api.inspect({ maxElements: 20, includeValues: false }).elements.find((item) => item.id === "prepare-projection").ref;
hit = preparationProjection;
await expectReject(
  () => api.prepareAction({ action: "click", selector: { ref: preparationRef }, elementTimeoutMs: 500 }),
  "outcome is unknown",
);
assert(preparationSideEffect === true,
  "trusted prepareAction projection failure did not preserve its prior scroll side-effect boundary");
preparationSideEffect = false;
elements = elements.filter((element) => element !== preparationProjection);
hit = button;

const host = new FakeElement("div");
host.contains = (node) => node === host || node === overlay;
const shadowRoot = new FakeShadowRoot();
shadowRoot.host = host;
button.rect = { x: 40, y: 60, width: 120, height: 32 };
button.getRootNode = () => shadowRoot;
hit = host;
await api.prepareAction({ action: "click", selector: { ref }, elementTimeoutMs: 500 });
hit = overlay;
await expectReject(() => api.prepareAction({ action: "click", selector: { ref }, elementTimeoutMs: 60 }), "outcome is unknown");

const checkable = new FakeInputElement({ id: "checkable", type: "checkbox" });
elements.push(checkable);
const checkRef = api.inspect({ maxElements: 20, includeValues: false }).elements.find((item) => item.id === "checkable").ref;
await api.action({ action: "check", selector: { ref: checkRef }, elementTimeoutMs: 500 });
assert(checkable.checked === true, "DOM check action did not reach the requested state");
const checkClicks = checkable.clickCount;
delete checkable.scrollOptions;
await api.action({ action: "check", selector: { ref: checkRef }, elementTimeoutMs: 500 });
assert(checkable.clickCount === checkClicks && checkable.scrollOptions === undefined,
  "already-satisfied DOM check still clicked or scrolled instead of returning a mutation-free no-op");
const checkableGetRootNode = checkable.getRootNode.bind(checkable);
checkable.getRootNode = () => { throw new Error("post-noop metadata unavailable"); };
let noOpProjectionError = null;
try { await api.action({ action: "check", selector: { ref: checkRef }, elementTimeoutMs: 500 }); }
catch (error) { noOpProjectionError = error; }
assert(String(noOpProjectionError?.message || noOpProjectionError).includes("post-noop metadata unavailable")
  && !String(noOpProjectionError?.message || noOpProjectionError).includes("outcome is unknown")
  && checkable.clickCount === checkClicks,
  "mutation-free no-op projection failure was incorrectly upgraded to ambiguous dispatch");
checkable.getRootNode = checkableGetRootNode;
checkable.click = function() { this.clickCount += 1; };
await expectReject(() => api.action({ action: "uncheck", selector: { ref: checkRef }, elementTimeoutMs: 500 }), "outcome is unknown");

const select = new FakeSelectElement({ id: "choice" });
select.options = [{ value: "present", text: "Present" }];
select.rect = { x: 80, y: 150, width: 180, height: 32 };
elements.push(select);
const selectRef = api.inspect({ maxElements: 30, includeValues: false }).elements.find((item) => item.id === "choice").ref;
await expectReject(() => api.action({ action: "select", selector: { ref: selectRef }, value: "missing", elementTimeoutMs: 500 }), "select option was not found");
assert(select.scrollOptions === undefined && select.focused === false,
  "missing DOM select option was detected only after a side-effecting scroll or focus");

input.focused = false;
await expectReject(() => api.action({ action: "press", selector: { ref: inputRef }, key: "Control+DefinitelyNotAKey", elementTimeoutMs: 500 }), "unsupported key");
assert(input.focused === false, "invalid DOM keyboard shortcut focused the target before validation failed");

input.value = "";
input.focused = false;
delete button.scrollOptions;
for (const malformed of [
  { action: "fill", selector: { ref: inputRef }, value: "x", elementTimeoutMs: 500, inputMode: "trusted" },
  { action: "fill", selector: { ref: inputRef }, value: ["x"], elementTimeoutMs: 500 },
  { action: "fill", selector: { ref: [inputRef] }, value: "x", elementTimeoutMs: 500 },
  { action: "fill", selector: { ref: inputRef }, value: "x", elementTimeoutMs: "500" },
  { action: "click", selector: { ref }, value: null, expectedIdentity: { name: ["Save"] }, elementTimeoutMs: 500 },
  { action: "press", selector: { ref: inputRef }, value: null, key: ["Enter"], elementTimeoutMs: 500 },
]) {
  await expectReject(() => api.action(malformed), "before dispatch");
}
assert(input.value === "" && input.focused === false && button.scrollOptions === undefined,
  "malformed renderer action payload caused focus, scroll, or value mutation before rejection");
await expectReject(() => api.prepareAction({ action: ["click"], selector: { ref }, elementTimeoutMs: 500 }), "before dispatch");
assert(button.scrollOptions === undefined, "malformed trusted-action payload scrolled the target before rejection");
await expectReject(() => Promise.resolve().then(() => api.pointProbe({ x: "10", y: 10 })), "outside the current viewport");
await expectReject(() => Promise.resolve().then(() => api.refIdentity({ ref: [inputRef] })), "element reference is invalid");
await expectReject(() => api.uploadFiles({
  selector: { ref: inputRef }, elementTimeoutMs: "500",
  files: [{ filename: "fixture.txt", mime: "text/plain", data: "Zml4dHVyZQ==" }],
}), "element timeout is invalid before dispatch");

await expectReject(() => api.fillForm({
  fields: [
    { selector: { ref: inputRef }, action: "fill", value: "must-not-apply", sensitive: false },
    { selector: { ref: inputRef }, action: ["fill"], value: "x", sensitive: false },
  ],
  elementTimeoutMs: 500,
  submit: false,
}), "form field 1 action is invalid before dispatch");
assert(input.value === "" && input.focused === false,
  "later malformed form-field schema was detected only after the first field mutated");
await expectReject(() => api.fillForm({
  fields: [{ selector: { ref: inputRef }, action: "fill", value: "must-not-apply", sensitive: false }],
  elementTimeoutMs: 500,
  submit: "false",
}), "form submit must be boolean before dispatch");
assert(input.value === "", "malformed form submit flag caused a field mutation before rejection");

await api.fillForm({
  fields: [
    { selector: { ref: inputRef }, action: "fill", value: "reset-after-static-preflight", sensitive: false },
  ],
  elementTimeoutMs: 500,
  submit: false,
});
assert(input.value === "reset-after-static-preflight", "valid renderer form payload stopped working after static preflight hardening");
input.value = "";

const rendererAggregateFields = Array.from({ length: 33 }, (_, index) => ({
  selector: { ref: inputRef }, action: "fill", value: `${index}:`.padEnd(128 * 1024, "a"), sensitive: false,
}));
await expectReject(() => api.fillForm({
  fields: rendererAggregateFields, elementTimeoutMs: 500, submit: false,
}), "4 MiB aggregate budget before dispatch");
assert(input.value === "", "over-budget renderer form mutated its first field before aggregate rejection");

await expectReject(() => api.fillForm({
  fields: [
    { selector: { ref: inputRef }, action: "fill", value: "partially-applied", sensitive: false },
    { selector: { ref: "e999999" }, action: "fill", value: "never-applied", sensitive: false },
  ],
  elementTimeoutMs: 50,
  submit: false,
}), "outcome is unknown");
assert(input.value === "partially-applied", "partial form failure test did not apply the earlier field");

const projectionInput = new FakeInputElement({ id: "projection-input", type: "text" });
projectionInput.rect = { x: 100, y: 180, width: 200, height: 32 };
let projectionInputMutated = false;
const projectionInputGetAttribute = projectionInput.getAttribute.bind(projectionInput);
const projectionInputDispatchEvent = projectionInput.dispatchEvent.bind(projectionInput);
projectionInput.getAttribute = (name) => {
  if (projectionInputMutated && name === "type") throw new Error("post-fill metadata unavailable");
  return projectionInputGetAttribute(name);
};
projectionInput.dispatchEvent = (event) => {
  const dispatched = projectionInputDispatchEvent(event);
  if (event.type === "change") projectionInputMutated = true;
  return dispatched;
};
elements.push(projectionInput);
const projectionInputRef = api.inspect({ maxElements: 20, includeValues: false }).elements.find((item) => item.id === "projection-input").ref;
await expectReject(() => api.fillForm({
  fields: [{ selector: { ref: projectionInputRef }, action: "fill", value: "applied-before-projection-failure", sensitive: false }],
  elementTimeoutMs: 500,
  submit: false,
}), "outcome is unknown");
assert(projectionInput.value === "applied-before-projection-failure",
  "post-fill metadata failure forgot that the first form mutation had already completed");
projectionInputMutated = false;
elements = elements.filter((element) => element !== projectionInput);

button.isConnected = false;
await expectReject(() => api.action({ action: "click", selector: { ref }, elementTimeoutMs: 50 }), "reference is stale");

const currentApi = context.__machineBridgePageAutomation;
vm.runInContext(source, context, { filename: "page-automation-reinject.js" });
assert(context.__machineBridgePageAutomation === currentApi,
  "same-version page automation reinjection replaced the current instance and invalidated refs or document epoch state");
const staleApi = Object.freeze({ action: async () => ({ stale: true }) });
Object.defineProperty(context, "__machineBridgePageAutomation", { value: staleApi, configurable: true });
vm.runInContext(source, context, { filename: "page-automation-upgrade.js" });
assert(context.__machineBridgePageAutomation !== staleApi
  && context.__machineBridgePageAutomation?.version === 4
  && typeof context.__machineBridgePageAutomation.action === "function",
  "stale page automation instance was not replaced by the current versioned module");

const textNodes = Array.from({ length: 2200 }, () => ({ data: "x".repeat(1024) }));
const textDocument = {
  title: "Text fixture",
  readyState: "complete",
  documentElement: { lang: "en" },
  body: {},
  getElementById() { return null; },
  createTreeWalker(_root, whatToShow) {
    let index = 0;
    const values = whatToShow === 4 ? textNodes : [];
    return { nextNode() { return values[index++] || null; } };
  },
};
const textContext = vm.createContext({
  document: textDocument,
  location: { href: "https://example.test/text" },
  innerWidth: 800,
  innerHeight: 600,
  getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  HTMLInputElement: FakeInputElement,
  HTMLTextAreaElement: FakeTextAreaElement,
  HTMLSelectElement: FakeSelectElement,
  ShadowRoot: FakeShadowRoot,
  Event: FakeEvent,
  MouseEvent: FakeEvent,
  KeyboardEvent: FakeEvent,
  PointerEvent: FakeEvent,
  DataTransfer: class {},
  File: class {},
  NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  Uint8Array,
  Date,
  URL,
  Promise,
  setTimeout,
  clearTimeout,
  console,
});
vm.runInContext(source, textContext, { filename: "page-automation-text.js" });
const textWait = textContext.__machineBridgePageAutomation.checkWait({ text: "not-present" });
assert(textWait.text_found === false && textWait.text_scan_truncated === true && textWait.text_scanned_chars === 2 * 1024 * 1024, "page-text wait did not enforce its cumulative character budget");

console.log("browser page automation test ok");

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
