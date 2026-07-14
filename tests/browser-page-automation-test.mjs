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
assert(api && typeof api.inspect === "function", "page automation module did not expose its fixed API");

const first = api.inspect({ maxElements: 10, includeValues: false });
const second = api.inspect({ maxElements: 10, includeValues: false });
const ref = first.elements[0]?.ref;
const inputRef = first.elements[1]?.ref;
assert(ref && inputRef && second.elements[0]?.ref === ref, "element reference was not stable within the document");
assert(first.snapshot_version === 2 && first.document.scanned_nodes === elements.length, "inspection did not expose bounded scan metadata");
assert(first.elements[0].bounding_box.x === 900, "inspection lost element geometry");
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

const host = new FakeElement("div");
host.contains = (node) => node === host || node === overlay;
const shadowRoot = new FakeShadowRoot();
shadowRoot.host = host;
button.rect = { x: 40, y: 60, width: 120, height: 32 };
button.getRootNode = () => shadowRoot;
hit = host;
await api.prepareAction({ action: "click", selector: { ref }, elementTimeoutMs: 500 });
hit = overlay;
await expectReject(() => api.prepareAction({ action: "click", selector: { ref }, elementTimeoutMs: 60 }), "obscured by another element");

const checkable = new FakeInputElement({ id: "checkable", type: "checkbox" });
elements.push(checkable);
const checkRef = api.inspect({ maxElements: 20, includeValues: false }).elements.find((item) => item.id === "checkable").ref;
await api.action({ action: "check", selector: { ref: checkRef }, elementTimeoutMs: 500 });
assert(checkable.checked === true, "DOM check action did not reach the requested state");
checkable.click = function() { this.clickCount += 1; };
await expectReject(() => api.action({ action: "uncheck", selector: { ref: checkRef }, elementTimeoutMs: 500 }), "did not reach the requested unchecked state");

input.value = "";
await expectReject(() => api.fillForm({
  fields: [
    { selector: { ref: inputRef }, action: "fill", value: "partially-applied" },
    { selector: { ref: "e999999" }, action: "fill", value: "never-applied" },
  ],
  elementTimeoutMs: 50,
  submit: false,
}), "after 1 earlier field(s) may have changed");
assert(input.value === "partially-applied", "partial form failure test did not apply the earlier field");

button.isConnected = false;
await expectReject(() => api.action({ action: "click", selector: { ref }, elementTimeoutMs: 50 }), "reference is stale");

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
