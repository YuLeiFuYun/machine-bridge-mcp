import {
  normalizeBrowserAction,
  normalizeBrowserSelector,
  normalizeBrowserWait,
  normalizeInputMode,
  normalizeTabCommand,
  validateNavigationUrl,
} from "../src/local/browser-command.mjs";

assert(normalizeBrowserAction("double_click") === "double_click", "double-click action was rejected");
assert(normalizeBrowserAction("type_text") === "type_text", "type-text action was rejected");
assert(normalizeInputMode(undefined) === "auto", "browser input mode did not default to auto");
assert(normalizeInputMode("trusted") === "trusted", "trusted browser input mode was rejected");

const ref = normalizeBrowserSelector({ ref: "e17" }, "click");
assert(ref.ref === "e17" && Object.keys(ref).length === 1, "stable browser element reference was not normalized");
await expectReject(() => normalizeBrowserSelector({ ref: "e1", role: "button" }, "click"), "cannot be combined");
await expectReject(() => normalizeBrowserSelector({ role: "button", unknown: true }, "click"), "unknown selector field");
await expectReject(() => normalizeBrowserSelector({ ref: "" }, "click"), "requires at least one field");

const wait = normalizeBrowserWait({ selector: { ref: "e2" }, timeout_seconds: 7 });
assert(wait.state === "visible" && wait.timeoutMs === 7000 && wait.selector.ref === "e2", "browser wait defaults are invalid");
const combined = normalizeBrowserWait({ text: "Ready", url_contains: "/complete", load_state: "complete" });
assert(combined.text === "Ready" && combined.urlContains === "/complete" && combined.loadState === "complete", "combined browser wait was not normalized");
await expectReject(() => normalizeBrowserWait({}), "requires selector");
await expectReject(() => normalizeBrowserWait({ state: "visible" }), "state requires selector");

const created = normalizeTabCommand({ action: "new", url: "https://example.test/form", active: false });
assert(created.url === "https://example.test/form" && created.active === false, "new-tab command was not normalized");
const activated = normalizeTabCommand({ action: "activate", tab_id: 9 });
assert(activated.tabId === 9, "activate-tab command lost its tab id");
await expectReject(() => normalizeTabCommand({ action: "close" }), "requires tab_id");
await expectReject(() => validateNavigationUrl("javascript:alert(1)"), "protocol must be http, https, or file");

console.log("browser command contract test ok");

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
