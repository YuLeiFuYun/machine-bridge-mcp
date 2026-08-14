import {
  browserPairingLaunchCommand,
  browserPairingLaunchUnknown,
  clampInt,
  normalizeBrowserAction,
  normalizeBrowserSelector,
  normalizeBrowserWait,
  normalizeFormAction,
  normalizeImageFormat,
  normalizeInputMode,
  normalizeNavigationWait,
  normalizeTabCommand,
  optionalBoolean,
  optionalInteger,
  optionalString,
  validateNavigationUrl,
} from "../src/local/browser-command.mjs";
import { publicError } from "../src/local/errors.mjs";

assert(normalizeBrowserAction("double_click") === "double_click", "double-click action was rejected");
assert(normalizeBrowserAction("type_text") === "type_text", "type-text action was rejected");
assert(normalizeInputMode(undefined) === "auto", "browser input mode did not default to auto");
assert(normalizeInputMode("trusted") === "trusted", "trusted browser input mode was rejected");
for (const value of [["click"], " click ", null, 1]) await expectReject(() => normalizeBrowserAction(value), "unsupported browser action");
for (const value of [["fill"], " fill ", null, 1]) await expectReject(() => normalizeFormAction(value), "unsupported form field action");
for (const value of [["trusted"], null, ""]) await expectReject(() => normalizeInputMode(value), "input_mode must be auto, trusted, or dom");
for (const value of [["complete"], null, ""]) await expectReject(() => normalizeNavigationWait(value), "wait_for must be none, domcontentloaded, or complete");
for (const value of ["7", [7], null, 7.5, Number.MAX_SAFE_INTEGER + 1]) await expectReject(() => optionalInteger(value, "tab_id", 1, Number.MAX_SAFE_INTEGER), "tab_id must be an integer");
for (const value of ["30", [30], null, 30.5]) await expectReject(() => clampInt(value, 30, 1, 120), "expected an integer");
for (const value of ["false", [false], null, 0]) await expectReject(() => optionalBoolean(value, "flag", false), "flag must be boolean");
assert(optionalBoolean(undefined, "flag", true) === true && optionalBoolean(false, "flag", true) === false, "optional boolean defaults or false value drifted");
for (const value of [["png"], null, "gif"]) await expectReject(() => normalizeImageFormat(value, "format"), "format must be png or jpeg");
assert(normalizeImageFormat(undefined) === "png" && normalizeImageFormat("jpeg") === "jpeg", "image format normalization drifted");
await expectReject(() => optionalString(null, "field", 10), "field must be a string");
assert(optionalString("", "field", 10) === "", "empty native string was not preserved");
assert(JSON.stringify(browserPairingLaunchCommand("http://127.0.0.1/pair", "darwin"))
  === JSON.stringify({ cmd: "open", argv: ["http://127.0.0.1/pair"] }), "macOS pairing launcher command changed");
assert(JSON.stringify(browserPairingLaunchCommand("http://127.0.0.1/pair", "win32"))
  === JSON.stringify({ cmd: "cmd.exe", argv: ["/d", "/s", "/c", "start", "", "http://127.0.0.1/pair"] }), "Windows pairing launcher command changed");
assert(JSON.stringify(browserPairingLaunchCommand("http://127.0.0.1/pair", "linux"))
  === JSON.stringify({ cmd: "xdg-open", argv: ["http://127.0.0.1/pair"] }), "Linux pairing launcher command changed");
const pairingUnknown = publicError(browserPairingLaunchUnknown());
assert(pairingUnknown.message.includes("pairing page may have been opened") && pairingUnknown.message.includes("outcome is unknown")
  && pairingUnknown.retryable === false, "pairing launch uncertainty was hidden or advertised as retryable at the MCP boundary");

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
await expectReject(() => normalizeBrowserWait({ selector: { ref: "e2" }, state: ["visible"] }), "state is not a supported browser wait state");
await expectReject(() => normalizeBrowserWait({ load_state: ["complete"] }), "load_state must be domcontentloaded or complete");
await expectReject(() => normalizeBrowserWait({ selector: { ref: "e2" }, timeout_seconds: "7" }), "expected an integer");
await expectReject(() => normalizeBrowserSelector({ ref: "e2", index: "1" }, "click"), "selector.index must be an integer");

const created = normalizeTabCommand({ action: "new", url: "https://example.test/form", active: false });
assert(created.url === "https://example.test/form" && created.active === false, "new-tab command was not normalized");
const activated = normalizeTabCommand({ action: "activate", tab_id: 9 });
assert(activated.tabId === 9, "activate-tab command lost its tab id");
await expectReject(() => normalizeTabCommand({ action: "close" }), "requires tab_id");
await expectReject(() => normalizeTabCommand({ action: ["new"] }), "browser tab action must be new, activate, or close");
await expectReject(() => normalizeTabCommand({ action: "activate", tab_id: "9" }), "tab_id must be an integer");
await expectReject(() => normalizeTabCommand({ action: "new", active: "false" }), "active must be boolean");
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
