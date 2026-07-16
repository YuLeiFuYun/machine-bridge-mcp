import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
vm.runInContext(source, context, { filename: "devtools-input.js" });
const api = context.__machineBridgeDevtoolsInput;
assert(api && typeof api.perform === "function", "trusted input module did not expose its fixed API");

await api.perform(7, "click", { point: { x: 10, y: 20 } });
assert(commands.map((entry) => entry.method).join(",") === "Input.dispatchMouseEvent,Input.dispatchMouseEvent,Input.dispatchMouseEvent", "trusted click did not use the fixed Input mouse sequence");
assert(commands[1].params.type === "mousePressed" && commands[2].params.type === "mouseReleased", "trusted click press/release sequence is invalid");
assert(lifecycle[0][0] === "attach" && lifecycle.at(-1)[0] === "detach", "debugger session was not bounded by attach/detach");

commands.length = 0;
await api.perform(7, "press", { key: "Control+A" });
assert(commands.length === 2 && commands.every((entry) => entry.method === "Input.dispatchKeyEvent"), "trusted key press did not use fixed key events");
assert(commands[0].params.modifiers === 2 && commands[0].params.key === "A", "trusted shortcut modifiers were not normalized");

commands.length = 0;
await api.perform(7, "type_text", { text: "bounded text" });
assert(commands.length === 1 && commands[0].method === "Input.insertText" && commands[0].params.text === "bounded text", "trusted text input did not use Input.insertText");
await expectReject(() => api.perform(7, "arbitrary", {}), "does not support");

const failingContext = vm.createContext({
  chrome: { debugger: { async attach() { throw new Error("already attached\nprivate detail"); }, async sendCommand() {}, async detach() {} } },
});
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
vm.runInContext(source, queuedContext, { filename: "devtools-input.js" });
await Promise.all([
  queuedContext.__machineBridgeDevtoolsInput.perform(9, "hover", { point: { x: 1, y: 1 } }),
  queuedContext.__machineBridgeDevtoolsInput.perform(9, "hover", { point: { x: 2, y: 2 } }),
]);
assert(maxActiveSessions === 1 && activeSessions === 0, "trusted input did not serialize debugger sessions per tab");

let detachedAfterCommandFailure = false;
const commandFailureContext = vm.createContext({
  chrome: { debugger: {
    async attach() {},
    async sendCommand() { throw new Error("input command failed"); },
    async detach() { detachedAfterCommandFailure = true; },
  } },
});
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
