import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const sessionSource = await readFile(new URL("../browser-extension/devtools-session.js", import.meta.url), "utf8");
const observationSource = await readFile(new URL("../browser-extension/devtools-observation.js", import.meta.url), "utf8");

await capturesAccessibilityGeometryAndScreenshot();
await detectsNavigationDuringCapture();
await componentFailuresPreserveAccessibility();
await cancellationStopsBeforeFurtherCommands();
console.log("browser DevTools observation test ok");

async function capturesAccessibilityGeometryAndScreenshot() {
  const lifecycle = [];
  const commands = [];
  let frameTreeCalls = 0;
  const context = createContext({
    async attach(target, version) { lifecycle.push(["attach", target.tabId, version]); },
    async detach(target) { lifecycle.push(["detach", target.tabId]); },
    async sendCommand(target, method, params) {
      commands.push({ tabId: target.tabId, method, params });
      if (method === "Page.enable" || method === "Accessibility.enable") return {};
      if (method === "Page.getFrameTree") {
        frameTreeCalls += 1;
        return frameTree("loader-a");
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1 } };
      }
      if (method === "DOMSnapshot.captureSnapshot") return domSnapshot();
      if (method === "Accessibility.getFullAXTree") {
        assert.equal(params.frameId, "frame-1");
        return { nodes: [
          {
            nodeId: "ax-root",
            ignored: false,
            role: { value: "RootWebArea" },
            name: { value: "Fixture" },
            frameId: "frame-1",
          },
          {
            nodeId: "ax-save",
            parentId: "ax-root",
            ignored: false,
            backendDOMNodeId: 42,
            frameId: "frame-1",
            role: { value: "button" },
            name: { value: "Save" },
            value: { value: "Button value" },
            properties: [{ name: "focusable", value: { value: true } }],
          },
          {
            nodeId: "ax-password",
            parentId: "ax-root",
            ignored: false,
            backendDOMNodeId: 43,
            frameId: "frame-1",
            role: { value: "textbox" },
            name: { value: "Password" },
            value: { value: "hunter2" },
            properties: [{ name: "editable", value: { value: true } }],
          },
          { nodeId: "ax-ignored", ignored: true, role: { value: "none" } },
        ] };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      throw new Error(`unexpected CDP command ${method}`);
    },
  });
  const result = await context.__machineBridgeDevtoolsObservation.capture(7, {
    maxNodes: 20,
    includeValues: true,
    includeScreenshot: true,
    format: "png",
  });

  assert.equal(result.navigation_coherent, true);
  assert.equal(result.document_epoch, "frame-1:loader-a:https://example.test/");
  assert.equal(result.screenshot.mime_type, "image/png");
  assert.equal(result.screenshot.data, "QUJD");
  const save = result.accessibility.nodes.find((node) => node.ax_id === "ax-save");
  assert(save, "actionable AX node was not retained");
  assert.equal(JSON.stringify(save.bounding_box), JSON.stringify({ x: 8, y: 17, width: 100, height: 30 }));
  assert.equal(save.clickable, true);
  assert.equal(save.value, "Button value");
  const password = result.accessibility.nodes.find((node) => node.ax_id === "ax-password");
  assert(password?.sensitive === true, "password-shaped AX field was not marked sensitive");
  assert.equal(Object.hasOwn(password, "value"), false, "sensitive AX value leaked into the observation");
  assert.equal(result.accessibility.ignored_nodes, 1);
  assert.equal(result.accessibility.available, true);
  assert.equal(result.components.dom_snapshot, true);
  assert.equal(result.components.screenshot, true);
  assert.equal(frameTreeCalls, 2, "capture must compare frame epochs before and after observation");
  const focused = await context.__machineBridgeDevtoolsObservation.capture(7, {
    maxNodes: 1, includeValues: false, includeScreenshot: false, focusQuery: "Password",
  });
  assert.equal(focused.accessibility.nodes[0]?.ax_id, "ax-password", "AX focus query did not promote the requested semantic target into the bounded observation");
  assert(focused.accessibility.nodes[0]?.focus_match_score > 0, "AX focus query did not expose per-node match evidence");
  assert.equal(focused.accessibility.query_matched, true);
  assert.equal(focused.accessibility.query_match_count, 1);
  assert.equal(focused.accessibility.query_search_exhaustive, false, "depth-bounded AX query incorrectly claimed exhaustive absence coverage");
  assert(focused.accessibility.top_query_score > 0);
  assert.equal(lifecycle[0][0], "attach");
  assert.equal(lifecycle.at(-1)[0], "detach");
  assert(commands.some((entry) => entry.method === "DOMSnapshot.captureSnapshot"), "observation omitted the fused DOM/layout snapshot");
  assert(commands.some((entry) => entry.method === "Accessibility.getFullAXTree"), "observation omitted the Chromium Accessibility tree");
}

async function detectsNavigationDuringCapture() {
  let frameTreeCalls = 0;
  const context = createContext({
    async attach() {},
    async detach() {},
    async sendCommand(_target, method) {
      if (method === "Page.enable" || method === "Accessibility.enable") return {};
      if (method === "Page.getFrameTree") {
        frameTreeCalls += 1;
        return frameTree(frameTreeCalls === 1 ? "loader-before" : "loader-after");
      }
      if (method === "Page.getLayoutMetrics") return {};
      if (method === "DOMSnapshot.captureSnapshot") return domSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      throw new Error(`unexpected CDP command ${method}`);
    },
  });
  const result = await context.__machineBridgeDevtoolsObservation.capture(8, { includeScreenshot: false });
  assert.equal(result.navigation_coherent, false, "loader replacement during capture was not detected");
}

async function componentFailuresPreserveAccessibility() {
  const context = createContext({
    async attach() {},
    async detach() {},
    async sendCommand(_target, method) {
      if (method === "Page.enable" || method === "Accessibility.enable") return {};
      if (method === "Page.getFrameTree") return frameTree("loader-stable");
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1 } };
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("fixture DOMSnapshot failure");
      if (method === "Accessibility.getFullAXTree") return { nodes: [{
        nodeId: "ax-only", ignored: false, backendDOMNodeId: 99, frameId: "frame-1",
        role: { value: "button" }, name: { value: "AX survives" }, properties: [],
      }] };
      if (method === "Page.captureScreenshot") throw new Error("fixture screenshot failure");
      throw new Error(`unexpected CDP command ${method}`);
    },
  });
  const result = await context.__machineBridgeDevtoolsObservation.capture(10, { includeScreenshot: true });
  assert.equal(result.navigation_coherent, true);
  assert.equal(result.components.dom_snapshot, false);
  assert.equal(result.components.screenshot, false);
  assert.equal(result.components.accessibility, true);
  assert.equal(result.screenshot, null);
  assert.equal(result.accessibility.nodes[0]?.ax_id, "ax-only");
  assert.equal(result.accessibility.nodes[0]?.bounding_box, null, "AX node unexpectedly required DOMSnapshot geometry");
}

async function cancellationStopsBeforeFurtherCommands() {
  const commands = [];
  const state = { cancelled: false };
  const context = createContext({
    async attach() {},
    async detach() {},
    async sendCommand(_target, method) {
      commands.push(method);
      if (method === "Page.enable") { state.cancelled = true; return {}; }
      throw new Error(`unexpected command after cancellation: ${method}`);
    },
  });
  await assert.rejects(
    () => context.__machineBridgeDevtoolsObservation.capture(9, { includeScreenshot: false }, state),
    /cancelled/,
  );
  assert.deepEqual(commands, ["Page.enable"], "cancelled observation continued issuing CDP commands");
}

function createContext(debuggerApi) {
  const context = vm.createContext({
    chrome: { debugger: debuggerApi },
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(sessionSource, context, { filename: "devtools-session.js" });
  vm.runInContext(observationSource, context, { filename: "devtools-observation.js" });
  return context;
}

function frameTree(loaderId) {
  return {
    frameTree: {
      frame: {
        id: "frame-1",
        loaderId,
        url: "https://example.test/",
        name: "",
      },
    },
  };
}

function domSnapshot() {
  return {
    strings: ["frame-1"],
    documents: [{
      frameId: 0,
      scrollOffsetX: 2,
      scrollOffsetY: 3,
      nodes: {
        backendNodeId: [1, 42, 43],
        isClickable: { index: [1] },
      },
      layout: {
        nodeIndex: [1, 2],
        bounds: [[10, 20, 100, 30], [20, 80, 200, 25]],
        paintOrders: [7, 8],
      },
    }],
  };
}
