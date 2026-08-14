import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const sessionSource = await readFile(new URL("../browser-extension/devtools-session.js", import.meta.url), "utf8");
const source = await readFile(new URL("../browser-extension/devtools-input.js", import.meta.url), "utf8");
const commands = [];
const lifecycle = [];
const context = vm.createContext({
  chrome: {
    debugger: {
      async attach(target, version) { lifecycle.push(["attach", target.tabId, version]); },
      async sendCommand(target, method, params) { commands.push({ tabId: target.tabId, method, params }); return {}; },
      async detach(target) { lifecycle.push(["detach", target.tabId]); },
    },
  },
});
vm.runInContext(sessionSource, context, { filename: "devtools-session.js" });
vm.runInContext(source, context, { filename: "devtools-input.js" });
const api = context.__machineBridgeDevtoolsInput;
assert(api && typeof api.perform === "function", "trusted input module did not expose its fixed API");

await api.perform(7, "click", { point: { x: 10, y: 20 } });
assert(commands.map((entry) => entry.method).join(",") === "Input.dispatchMouseEvent,Input.dispatchMouseEvent,Input.dispatchMouseEvent", "trusted click did not use the fixed Input mouse sequence");
assert(commands[1].params.type === "mousePressed" && commands[2].params.type === "mouseReleased", "trusted click press/release sequence is invalid");
assert(lifecycle[0][0] === "attach" && lifecycle.at(-1)[0] === "detach", "debugger session was not bounded by attach/detach");

commands.length = 0;
await api.perform(7, "drag", { point: { x: 10, y: 20 }, destinationPoint: { x: 110, y: 70 } });
assert(commands.length === 11 && commands.every((entry) => entry.method === "Input.dispatchMouseEvent"),
  "trusted drag did not use the fixed move/press/interpolated-move/release sequence");
assert(commands[0].params.type === "mouseMoved"
  && commands[1].params.type === "mousePressed"
  && commands.slice(2, -1).every((entry) => entry.params.type === "mouseMoved" && entry.params.buttons === 1)
  && commands.at(-1).params.type === "mouseReleased",
"trusted drag mouse phases are invalid");
assert(commands.at(-1).params.x === 110 && commands.at(-1).params.y === 70,
  "trusted drag did not release at the requested destination");

commands.length = 0;
await api.perform(7, "scroll", { point: { x: 25, y: 35 }, deltaX: 120, deltaY: -480 });
assert(commands.length === 1 && commands[0].method === "Input.dispatchMouseEvent",
  "trusted scroll emitted more than one mutation command");
assert(commands[0].params.type === "mouseWheel"
  && commands[0].params.x === 25 && commands[0].params.y === 35
  && commands[0].params.deltaX === 120 && commands[0].params.deltaY === -480,
"trusted scroll did not preserve the snapshot anchor and CSS-pixel wheel deltas");

commands.length = 0;
await api.perform(7, "press", { key: "Control+A" });
assert(commands.length === 2 && commands.every((entry) => entry.method === "Input.dispatchKeyEvent"), "trusted key press did not use fixed key events");
assert(commands[0].params.modifiers === 2 && commands[0].params.key === "A", "trusted shortcut modifiers were not normalized");

commands.length = 0;
await api.perform(7, "type_text", { text: "bounded text" });
assert(commands.length === 1 && commands[0].method === "Input.insertText" && commands[0].params.text === "bounded text", "trusted text input did not use Input.insertText");
await expectReject(() => api.perform(7, "arbitrary", {}), "does not support");
await expectReject(() => api.perform(7, "press", { key: "constructor+A" }), "unsupported key modifier");
await expectReject(() => api.perform(7, "press", { key: "constructor" }), "unsupported key");

let malformedPreflightCommands = 0;
const rejectBeforeCommand = async (action, details, expected) => {
  const error = await capturedError(() => api.performWithSend(async () => { malformedPreflightCommands += 1; return {}; }, action, details));
  assert(error.machineBridgeTrustedInput === true && error.safeToFallback === true && error.dispatchStarted === false,
    `malformed trusted ${action} input was not classified as a definite pre-dispatch failure`);
  assert(String(error.message).includes(expected), `malformed trusted ${action} input lost its validation reason`);
};
await rejectBeforeCommand("click", { point: { x: "10", y: 20 } }, "usable viewport point");
await rejectBeforeCommand("drag", { point: { x: 10, y: 20 }, destinationPoint: { x: [30], y: 40 } }, "usable viewport point");
await rejectBeforeCommand("type_text", { text: ["x"] }, "text is invalid before dispatch");
await rejectBeforeCommand("press", { key: ["Enter"] }, "key is invalid before dispatch");
await rejectBeforeCommand("click", { point: { x: 10, y: 20 }, text: "smuggled" }, "unknown trusted input detail 'text'");
await rejectBeforeCommand("type_text", { text: "x", point: { x: 10, y: 20 } }, "unknown trusted input detail 'point'");
await rejectBeforeCommand("click", { point: { x: 10, y: 20 }, expectedScreenshotSha256: ["a".repeat(64)], screenshotFormat: "png", screenshotQuality: 90 }, "visual_snapshot_digest_invalid_before_dispatch");
await rejectBeforeCommand("click", { point: { x: 10, y: 20 }, expectedScreenshotSha256: "a".repeat(64), screenshotFormat: ["png"], screenshotQuality: 90 }, "visual_snapshot_format_invalid_before_dispatch");
await rejectBeforeCommand("click", { point: { x: 10, y: 20 }, expectedScreenshotSha256: "a".repeat(64), screenshotFormat: "png", screenshotQuality: "90" }, "visual_snapshot_quality_invalid_before_dispatch");
assert(malformedPreflightCommands === 0, "malformed trusted input reached CDP before static preflight rejection");

let malformedAttachCount = 0;
const malformedAttachContext = vm.createContext({
  chrome: { debugger: {
    async attach() { malformedAttachCount += 1; },
    async sendCommand() { throw new Error("malformed trusted input must not reach CDP"); },
    async detach() {},
  } },
});
vm.runInContext(sessionSource, malformedAttachContext, { filename: "devtools-session.js" });
vm.runInContext(source, malformedAttachContext, { filename: "devtools-input.js" });
const malformedBeforeAttach = await capturedError(() => malformedAttachContext.__machineBridgeDevtoolsInput.perform(7, "click", { point: { x: "10", y: 20 } }));
assert(malformedBeforeAttach.machineBridgeTrustedInput === true && malformedBeforeAttach.safeToFallback === true
  && malformedBeforeAttach.dispatchStarted === false && malformedAttachCount === 0,
"malformed trusted input attached the debugger before static payload validation");

const failingContext = vm.createContext({
  chrome: { debugger: { async attach() { throw new Error("already attached\nprivate detail"); }, async sendCommand() {}, async detach() {} } },
});
vm.runInContext(sessionSource, failingContext, { filename: "devtools-session.js" });
vm.runInContext(source, failingContext, { filename: "devtools-input.js" });
const attachFailure = await capturedError(() => failingContext.__machineBridgeDevtoolsInput.perform(8, "click", { point: { x: 1, y: 1 } }));
assert(attachFailure.message.includes("trusted browser input unavailable: already attached private detail"), "trusted attach failure was not sanitized");
assert(attachFailure.safeToFallback === true && attachFailure.dispatchStarted === false, "pre-dispatch attach failure was not marked safe for fallback");

let activeSessions = 0;
let maxActiveSessions = 0;
const queuedContext = vm.createContext({
  setTimeout,
  chrome: { debugger: {
    async attach() { activeSessions += 1; maxActiveSessions = Math.max(maxActiveSessions, activeSessions); },
    async sendCommand() { await new Promise((resolve) => { setTimeout(resolve, 10); }); },
    async detach() { activeSessions -= 1; },
  } },
});
vm.runInContext(sessionSource, queuedContext, { filename: "devtools-session.js" });
vm.runInContext(source, queuedContext, { filename: "devtools-input.js" });
await Promise.all([
  queuedContext.__machineBridgeDevtoolsInput.perform(9, "hover", { point: { x: 1, y: 1 } }),
  queuedContext.__machineBridgeDevtoolsInput.perform(9, "hover", { point: { x: 2, y: 2 } }),
]);
assert(maxActiveSessions === 1 && activeSessions === 0, "trusted input did not serialize debugger sessions per tab");

let queuedAttachCount = 0;
let queuedDetachCount = 0;
let releaseFirstQueuedCommand;
let markFirstQueuedCommandStarted;
const firstQueuedCommandStarted = new Promise((resolve) => { markFirstQueuedCommandStarted = resolve; });
const queuedCancellationContext = vm.createContext({
  chrome: { debugger: {
    async attach() { queuedAttachCount += 1; },
    async sendCommand() {
      markFirstQueuedCommandStarted();
      await new Promise((resolve) => { releaseFirstQueuedCommand = resolve; });
    },
    async detach() { queuedDetachCount += 1; },
  } },
});
vm.runInContext(sessionSource, queuedCancellationContext, { filename: "devtools-session.js" });
vm.runInContext(source, queuedCancellationContext, { filename: "devtools-input.js" });
const firstQueuedInput = queuedCancellationContext.__machineBridgeDevtoolsInput.perform(14, "hover", { point: { x: 1, y: 1 } });
await firstQueuedCommandStarted;
let secondQueuedCancelled = false;
const secondQueuedInput = queuedCancellationContext.__machineBridgeDevtoolsInput.perform(14, "hover", {
  point: { x: 2, y: 2 },
  beforeDispatch() {
    if (!secondQueuedCancelled) return;
    const error = new Error("browser request cancelled");
    Object.defineProperty(error, "machineBridgeBeforeDispatchAbort", { value: true });
    throw error;
  },
});
secondQueuedCancelled = true;
releaseFirstQueuedCommand();
await firstQueuedInput;
const queuedCancellation = await capturedError(() => secondQueuedInput);
assert(queuedCancellation.machineBridgeBeforeDispatchAbort === true,
  "queued trusted input cancellation lost its pre-dispatch abort marker");
assert(queuedAttachCount === 1 && queuedDetachCount === 1,
  "queued trusted input attached the debugger after cancellation arrived before its session started");

const expectedScreenshotHash = createHash("sha256").update(Buffer.from("ABC")).digest("hex");
const visualCommands = [];
const visualContext = vm.createContext({
  crypto: webcrypto,
  atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
  Uint8Array,
  chrome: { debugger: {
    async attach() {},
    async sendCommand(_target, method, params) {
      visualCommands.push({ method, params });
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    },
    async detach() {},
  } },
});
vm.runInContext(sessionSource, visualContext, { filename: "devtools-session.js" });
vm.runInContext(source, visualContext, { filename: "devtools-input.js" });
await visualContext.__machineBridgeDevtoolsInput.perform(11, "click", {
  point: { x: 10, y: 20 }, expectedScreenshotSha256: expectedScreenshotHash, screenshotFormat: "png", screenshotQuality: 90,
});
assert(visualCommands[0].method === "Page.enable" && visualCommands[1].method === "Page.captureScreenshot", "visual snapshot was not revalidated before trusted input");
assert(visualCommands.slice(2).every((entry) => entry.method === "Input.dispatchMouseEvent"), "trusted input did not follow visual snapshot verification");

const malformedCaptureCommands = [];
const malformedCaptureContext = vm.createContext({
  crypto: webcrypto,
  atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
  Uint8Array,
});
vm.runInContext(source, malformedCaptureContext, { filename: "devtools-input.js" });
const malformedCapture = await capturedError(() => malformedCaptureContext.__machineBridgeDevtoolsInput.performWithSend(async (method) => {
  malformedCaptureCommands.push(method);
  if (method === "Page.captureScreenshot") return { data: ["QUJD"] };
  return {};
}, "click", {
  point: { x: 10, y: 20 }, expectedScreenshotSha256: expectedScreenshotHash, screenshotFormat: "png", screenshotQuality: 90,
}));
assert(malformedCapture.machineBridgeTrustedInput === true && malformedCapture.safeToFallback === true && malformedCapture.dispatchStarted === false,
  "malformed screenshot verification payload was not rejected before trusted Input");
assert(malformedCapture.message.includes("visual_snapshot_capture_invalid_before_dispatch"),
  "malformed screenshot verification payload lost its typed pre-dispatch marker");
assert(malformedCaptureCommands.join(",") === "Page.enable,Page.captureScreenshot",
  "malformed screenshot verification payload reached trusted Input or skipped the bounded verification capture");

let cancelledBeforeVisualCommands = 0;
const cancelledBeforeVisual = await capturedError(() => visualContext.__machineBridgeDevtoolsInput.performWithSend(async () => {
  cancelledBeforeVisualCommands += 1; return {};
}, "click", {
  point: { x: 10, y: 20 }, expectedScreenshotSha256: expectedScreenshotHash, screenshotFormat: "png", screenshotQuality: 90,
  beforeDispatch() {
    const error = new Error("browser request cancelled before visual verification");
    Object.defineProperty(error, "machineBridgeBeforeDispatchAbort", { value: true });
    throw error;
  },
}));
assert(cancelledBeforeVisual.machineBridgeBeforeDispatchAbort === true && cancelledBeforeVisualCommands === 0,
  "pre-existing trusted visual cancellation still captured a screenshot or reached Input");

let cancelledAfterVisualVerification = false;
let detachedAfterVisualCancellation = false;
const cancelledVisualCommands = [];
const cancelledVisualContext = vm.createContext({
  crypto: webcrypto,
  atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
  Uint8Array,
  chrome: { debugger: {
    async attach() {},
    async sendCommand(_target, method, params) {
      cancelledVisualCommands.push({ method, params });
      if (method === "Page.captureScreenshot") {
        cancelledAfterVisualVerification = true;
        return { data: "QUJD" };
      }
      return {};
    },
    async detach() { detachedAfterVisualCancellation = true; },
  } },
});
vm.runInContext(sessionSource, cancelledVisualContext, { filename: "devtools-session.js" });
vm.runInContext(source, cancelledVisualContext, { filename: "devtools-input.js" });
const visualCancellation = await capturedError(() => cancelledVisualContext.__machineBridgeDevtoolsInput.perform(13, "click", {
  point: { x: 10, y: 20 }, expectedScreenshotSha256: expectedScreenshotHash, screenshotFormat: "png", screenshotQuality: 90,
  beforeDispatch() {
    if (!cancelledAfterVisualVerification) return;
    const error = new Error("browser request cancelled");
    Object.defineProperty(error, "machineBridgeBeforeDispatchAbort", { value: true });
    throw error;
  },
}));
assert(visualCancellation.message === "browser request cancelled" && visualCancellation.machineBridgeBeforeDispatchAbort === true,
  "visual pre-dispatch cancellation was rewritten as trusted-input uncertainty");
assert(cancelledVisualCommands.every((entry) => !entry.method.startsWith("Input.")),
  "visual pre-dispatch cancellation still reached trusted Input");
assert(detachedAfterVisualCancellation, "visual pre-dispatch cancellation did not detach its bounded debugger session");

const changedVisualCommands = [];
const changedVisualContext = vm.createContext({
  crypto: webcrypto,
  atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
  Uint8Array,
  chrome: { debugger: {
    async attach() {},
    async sendCommand(_target, method) {
      changedVisualCommands.push(method);
      if (method === "Page.captureScreenshot") return { data: "REVG" };
      return {};
    },
    async detach() {},
  } },
});
vm.runInContext(sessionSource, changedVisualContext, { filename: "devtools-session.js" });
vm.runInContext(source, changedVisualContext, { filename: "devtools-input.js" });
const changedVisual = await capturedError(() => changedVisualContext.__machineBridgeDevtoolsInput.perform(12, "click", {
  point: { x: 10, y: 20 }, expectedScreenshotSha256: expectedScreenshotHash, screenshotFormat: "png", screenshotQuality: 90,
}));
assert(changedVisual.message.includes("visual_snapshot_changed_before_dispatch"), "changed visual snapshot lost its typed pre-dispatch marker");
assert(changedVisual.safeToFallback === true && changedVisual.dispatchStarted === false, "changed visual snapshot was not rejected before Input dispatch");
assert(changedVisualCommands.every((method) => !method.startsWith("Input.")), "changed visual snapshot reached trusted Input dispatch");

let fillDispatches = 0;
const fillContext = vm.createContext({});
vm.runInContext(source, fillContext, { filename: "devtools-input.js" });
const fillFailure = await capturedError(() => fillContext.__machineBridgeDevtoolsInput.performWithSend(async () => {
  fillDispatches += 1;
  if (fillDispatches === 3) throw new Error("fixture fill dispatch failure");
}, "fill_text", { text: "secret-ish", selectAllKey: "Control+A" }));
assert(fillFailure.machineBridgeTrustedInput === true, "composite fill failure lost trusted-input classification");
assert(fillFailure.safeToFallback === false && fillFailure.dispatchStarted === true,
  "composite fill failure after earlier Input commands was incorrectly safe to fall back");
assert(fillDispatches === 3, "composite fill test did not fail after a partial trusted sequence");

const dragFailureCommands = [];
const dragFailureContext = vm.createContext({});
vm.runInContext(source, dragFailureContext, { filename: "devtools-input.js" });
let dragDispatches = 0;
const dragFailure = await capturedError(() => dragFailureContext.__machineBridgeDevtoolsInput.performWithSend(async (_method, params) => {
  dragDispatches += 1;
  dragFailureCommands.push(params);
  if (dragDispatches === 5) throw new Error("fixture drag move response lost");
}, "drag", { point: { x: 5, y: 5 }, destinationPoint: { x: 105, y: 55 } }));
assert(dragFailure.machineBridgeTrustedInput === true && dragFailure.safeToFallback === false && dragFailure.dispatchStarted === true,
  "partial drag failure was incorrectly classified as safe to replay");
assert(dragFailureCommands[1].type === "mousePressed" && dragFailureCommands.at(-1).type === "mouseReleased",
  "partial drag failure did not attempt a best-effort button release");

const scrollFailureContext = vm.createContext({});
vm.runInContext(source, scrollFailureContext, { filename: "devtools-input.js" });
const scrollFailure = await capturedError(() => scrollFailureContext.__machineBridgeDevtoolsInput.performWithSend(async () => {
  throw new Error("fixture wheel response lost");
}, "scroll", { point: { x: 50, y: 60 }, deltaX: 0, deltaY: 500 }));
assert(scrollFailure.machineBridgeTrustedInput === true && scrollFailure.safeToFallback === false && scrollFailure.dispatchStarted === true,
  "wheel response loss was incorrectly classified as safe to replay through another scroll mechanism");

let detachedAfterCommandFailure = false;
const commandFailureContext = vm.createContext({
  chrome: { debugger: {
    async attach() {},
    async sendCommand() { throw new Error("input command failed"); },
    async detach() { detachedAfterCommandFailure = true; },
  } },
});
vm.runInContext(sessionSource, commandFailureContext, { filename: "devtools-session.js" });
vm.runInContext(source, commandFailureContext, { filename: "devtools-input.js" });
const commandFailure = await capturedError(() => commandFailureContext.__machineBridgeDevtoolsInput.perform(10, "hover", { point: { x: 1, y: 1 } }));
assert(commandFailure.message.includes("input command failed"), "trusted command failure lost its error detail");
assert(commandFailure.safeToFallback === false && commandFailure.dispatchStarted === true, "post-dispatch command failure was incorrectly marked safe for fallback");
assert(detachedAfterCommandFailure, "trusted input did not detach after a command failure");

console.log("browser trusted input test ok");

async function capturedError(operation) {
  try { await operation(); } catch (error) { return error; }
  throw new Error("expected operation to reject");
}

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
