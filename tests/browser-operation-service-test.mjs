import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { BrowserOperationService } from "../src/local/browser-operation-service.mjs";

const authorized = [];
const requests = [];
const launches = [];
const processCalls = [];
const bridge = {
  extensionConnected: true,
  brokerRole: "owner",
  runtime_clients: 2,
  routed_requests: 3,
  port: 42123,
  extensionGeneration: 1,
  extensionReloadRequired: false,
  extensionInfo: {
    extension_id: "abcdefghijklmnopabcdefghijklmnop",
    protocol: 3,
    version: "3.0.0-beta.70",
    capabilities: ["trusted_input", "computer_observation_v1", "cdp_accessibility_snapshot", "cdp_surface_screenshot", "backend_node_trusted_input"],
  },
};

const service = new BrowserOperationService({
  authorizeTool(tool) { authorized.push(tool); },
  async ensureStarted() {},
  request: async (method, params, timeoutSeconds) => {
    requests.push({ method, params, timeoutSeconds });
    if (method === "screenshot") {
      return { data: "data:image/png;base64,AA==", tab_id: 7, url: "https://example.test", title: "Example", tab_metadata_verified: true };
    }
    return { ok: true, method };
  },
  bridgeStatus: () => bridge,
  createPairingLaunch: async (port) => {
    const launch = { url: `http://127.0.0.1:${port}/pair#grant`, closed: false, close() { this.closed = true; } };
    launches.push(launch);
    return launch;
  },
  extensionPath: "/synthetic/extension",
  expectedExtensionVersion: "3.0.0-beta.70",
  expectedExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  runProcess: async (...args) => { processCalls.push(args); return { code: 0 }; },
  readResourceText: async (name) => name === "secret" ? "private-value" : "text-value",
  readResourceBinary: (name) => ({ buffer: Buffer.from(`file:${name}`), path: `/synthetic/${name}.txt` }),
  throwIfCancelled() {},
});

const status = await service.status();
assert.equal(status.connected, true);
assert.equal(status.computer_observation_v1, true);
assert.equal(status.cdp_surface_screenshot, true);
assert.equal(status.trusted_input, true);
assert.equal(status.trusted_input_quarantined, false);
assert.equal(status.endpoint, "ws://127.0.0.1:42123/extension");

const pairClosed = await service.pair({ open: false });
assert.equal(pairClosed.opened_pairing_page, false);
assert.equal(launches.length, 0);
const pairOpened = await service.pair({ open: true });
assert.equal(pairOpened.opened_pairing_page, true);
assert.equal(launches.length, 1);
assert.equal(processCalls.length, 1);
assert.equal(launches[0].closed, false);

await service.listTabs({ current_window: true, include_pinned: false, timeout_seconds: 12 });
await service.manageTabs({ action: "new", url: "https://example.test", active: false, timeout_seconds: 11 });
await service.wait({ text: "ready", timeout_seconds: 9 });
await service.getSource({ tab_id: 7, frame_id: 0, all_frames: true, max_bytes: 4096, timeout_seconds: 8 });
await service.inspectPage({ tab_id: 7, frame_id: 0, all_frames: false, max_elements: 20, include_values: true, focus_query: "save", timeout_seconds: 7 });
await service.documentState({ tab_id: 7, timeout_seconds: 5 });
await service.pointAction({
  tab_id: 7,
  action: "click",
  normalized_x: 0.5,
  normalized_y: 0.5,
  document_epoch: "doc-1",
  viewport: { width: 800, height: 600, scale: 1 },
  screenshot_sha256: "a".repeat(64),
  screenshot_format: "png",
  screenshot_quality: 90,
  timeout_seconds: 5,
});

const navigate = await service.act({ action: "navigate", url: "https://example.test/next", timeout_seconds: 6 });
assert.equal(navigate.method, "action");
assert.equal(navigate.value_exposed, false);
const filled = await service.act({ action: "fill", selector: { ref: "e1" }, value_resource: "secret", timeout_seconds: 6 });
assert.equal(filled.value_source, "local-resource");
assert.equal(filled.value_exposed, false);

const form = await service.fillForm({
  tab_id: 7,
  fields: [
    { selector: { ref: "e1" }, value: "public", action: "fill" },
    { selector: { ref: "e2" }, value_resource: "secret", action: "fill" },
  ],
  submit: true,
  submit_selector: { ref: "e3" },
  timeout_seconds: 15,
});
assert.equal(form.method, "fill_form");

const upload = await service.uploadFiles({
  tab_id: 7,
  selector: { ref: "e4" },
  resources: ["sample"],
  filenames: ["sample.txt"],
  mime_types: ["text/plain"],
  timeout_seconds: 15,
});
assert.deepEqual(upload.resource_names, ["sample"]);
assert.equal(upload.resource_contents_exposed, false);

const screenshot = await service.screenshot({ tab_id: 7, format: "png", timeout_seconds: 5 });
assert.equal(screenshot.$mcp.content[0].type, "image");
assert.equal(screenshot.$mcp.content[0].data, "AA==");
assert.equal(screenshot.$mcp.structuredContent.tab_metadata_verified, true);

for (const method of ["list_tabs", "manage_tabs", "wait", "get_source", "inspect_page", "document_state", "point_action", "action", "fill_form", "upload_files", "screenshot"]) {
  assert(requests.some((entry) => entry.method === method), `missing request coverage for ${method}`);
}
for (const tool of [
  "browser_status", "pair_browser_extension", "browser_list_tabs", "browser_manage_tabs", "browser_wait", "browser_get_source",
  "browser_inspect_page", "computer_act", "browser_action", "browser_fill_form", "browser_upload_files", "browser_screenshot",
]) {
  assert(authorized.includes(tool), `missing authorization coverage for ${tool}`);
}

const healthBridge = {
  ...bridge,
  extensionGeneration: 10,
  extensionInfo: { ...bridge.extensionInfo, capabilities: [...bridge.extensionInfo.capabilities] },
};
const healthRequests = [];
let trustedFailures = 0;
const healthService = new BrowserOperationService({
  authorizeTool() {},
  async ensureStarted() {},
  request: async (method, params) => {
    healthRequests.push({ method, params });
    if (method === "action" && params.inputMode === "auto" && trustedFailures++ === 0) {
      throw new Error("trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying.");
    }
    return { ok: true, input_mode: params.inputMode || "" };
  },
  bridgeStatus: () => healthBridge,
  createPairingLaunch: async () => ({ url: "", close() {} }),
  extensionPath: "/synthetic/extension",
  expectedExtensionVersion: healthBridge.extensionInfo.version,
  expectedExtensionId: healthBridge.extensionInfo.extension_id,
  runProcess: async () => ({ code: 0 }),
  readResourceText: async () => "value",
  readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "/synthetic/file" }),
});

await assert.rejects(
  healthService.act({ action: "hover", selector: { ref: "e1" }, input_mode: "auto" }),
  /trusted browser input may have been partially dispatched/,
  "the first ambiguous trusted action must remain unknown and must not be replayed",
);
assert.equal(healthRequests.length, 1);
const quarantinedStatus = await healthService.status();
assert.equal(quarantinedStatus.trusted_input, false);
assert.equal(quarantinedStatus.trusted_input_quarantined, true);
assert.equal(quarantinedStatus.trusted_input_health, "quarantined");
assert.equal(quarantinedStatus.backend_node_trusted_input, false);

const fallback = await healthService.act({ action: "hover", selector: { ref: "e1" }, input_mode: "auto" });
assert.equal(healthRequests.length, 2);
assert.equal(healthRequests[1].params.inputMode, "dom", "quarantined auto actions must bypass trusted preparation before extension dispatch");
assert.equal(fallback.trusted_input_fallback, true);
assert.equal(fallback.fallback_reason, "trusted_input_quarantined_after_ambiguous_failure");

await assert.rejects(
  healthService.act({ action: "hover", selector: { ref: "e1" }, input_mode: "trusted" }),
  (error) => error?.code === "unavailable" && error?.details?.reason === "browser_trusted_input_quarantined" && error?.details?.side_effects_started === false,
  "explicit trusted input must fail definitely before dispatch while quarantined",
);
assert.equal(healthRequests.length, 2, "explicit trusted quarantine failure must not reach the extension");

await assert.rejects(
  healthService.backendNodeAction({ action: "hover", backend_node_id: 7, timeout_seconds: 5 }),
  (error) => error?.code === "unavailable" && error?.details?.reason === "browser_trusted_input_quarantined",
  "snapshot backend trusted input must fail before mutation while quarantined",
);
assert.equal(healthRequests.length, 2, "snapshot backend quarantine failure must not reach the extension");

healthBridge.extensionGeneration = 11;
const recoveredStatus = await healthService.status();
assert.equal(recoveredStatus.trusted_input, true, "a fresh extension connection generation resets the quarantine");
assert.equal(recoveredStatus.trusted_input_quarantined, false);
await healthService.act({ action: "hover", selector: { ref: "e1" }, input_mode: "trusted" });
assert.equal(healthRequests.length, 3, "a fresh extension connection may attempt trusted input once again");

console.log("browser operation service test ok");
