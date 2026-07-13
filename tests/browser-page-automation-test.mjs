import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
  click() { this.clickCount += 1; }
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
const elements = [button, input];
let hit = overlay;
const document = {
  title: "Fixture",
  readyState: "complete",
  documentElement: { lang: "en" },
  body: { innerText: "Fixture page", textContent: "Fixture page" },
  querySelectorAll(selector) {
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
  Promise,
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
assert(first.elements[0].bounding_box.x === 900, "inspection lost element geometry");

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

button.isConnected = false;
await expectReject(() => api.action({ action: "click", selector: { ref }, elementTimeoutMs: 50 }), "reference is stale");

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
