import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BrowserBridgeManager } from "../src/local/browser-bridge.mjs";
import { EXPECTED_EXTENSION_ID } from "../src/local/browser-extension-identity.mjs";

const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

await testStopDuringStart();
await testStartFailureCleanup();

const root = await mkdtemp(join(tmpdir(), "mbm-browser-bridge-"));
if (process.platform !== "win32") await chmod(root, 0o777);
const policy = { profile: "full", execMode: "shell", unrestrictedPaths: true };
const common = {
  policy,
  stateRoot: root,
  runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
  readResourceText: async () => "secret-value",
  readResourceBinary: () => ({ buffer: Buffer.from("file-data"), path: join(root, "upload.txt"), size: 9 }),
};
const owner = new BrowserBridgeManager(common);
const client = new BrowserBridgeManager(common);
let extension;
let replacementExtension;
let invalidOrigin;
let invalidExtension;
let malformedExtension;
let staleExtension;
let staleReplacement;
let invalidRuntime;
let holdListTabs = false;
let heldRequestId = "";
let cancelledRequestId = "";
try {
  const initial = await owner.status();
  if (process.platform !== "win32" && ((await stat(root)).mode & 0o777) !== 0o700) {
    throw new Error("browser pairing state root was not restricted to 0700");
  }
  assert(initial.broker_role === "owner", "first browser bridge did not become owner");
  assert(initial.runtime_clients === 0 && initial.routed_requests === 0, "browser status omitted read-only broker load diagnostics");
  assert(initial.connected === false, "browser bridge unexpectedly reported an extension");
  assert(initial.semantic_snapshot_refs === true && initial.actionability_waits === true && initial.trusted_input === true, "browser status omitted production interaction capabilities");
  assert(initial.tab_management === true && initial.explicit_waits === true, "browser status omitted tab or wait capabilities");
  const disconnectedClientStatus = await client.status();
  assert(disconnectedClientStatus.broker_role === "client" && disconnectedClientStatus.connected === false, "broker client incorrectly reported an extension before pairing");
  assert(disconnectedClientStatus.extension_reload_required === false, "broker client confused an absent extension with a stale extension");
  assert(initial.pairing_url.endsWith("/pair") && !initial.pairing_url.includes("#"), "pairing token leaked through the URL fragment");

  const pairing = JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"));
  assert(pairing.schemaVersion === 2 && pairing.extensionToken !== pairing.runtimeToken, "browser pairing state did not separate extension and runtime credentials");
  assert(!JSON.stringify(initial).includes(pairing.extensionToken) && !JSON.stringify(initial).includes(pairing.runtimeToken), "browser status exposed a pairing credential");
  const response = await fetch(initial.pairing_url, { signal: AbortSignal.timeout(5000) });
  const html = await response.text();
  assert(response.status === 200 && html.includes(pairing.extensionToken), "local pairing page did not contain the local-only token");
  assert(html.includes("Expected extension build") && html.includes(PACKAGE_VERSION), "local pairing page omitted extension reload diagnostics");
  assert(html.includes("Expected extension ID") && html.includes(EXPECTED_EXTENSION_ID), "local pairing page omitted the pinned extension identity");
  assert(response.headers.get("cache-control") === "no-store", "pairing page is cacheable");
  assert(!html.includes(pairing.runtimeToken), "local pairing page exposed the owner-only runtime credential");

  const tokenRoleRuntimeUrl = new URL(initial.endpoint);
  tokenRoleRuntimeUrl.pathname = "/runtime";
  await expectSocketRejected(new WebSocket(tokenRoleRuntimeUrl, [`mbm-runtime.${pairing.extensionToken}`]));
  await expectSocketRejected(new WebSocket(initial.endpoint, [`mbm.${pairing.runtimeToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` }));

  const rejected = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: "https://example.test" });
  await expectSocketRejected(rejected);
  invalidOrigin = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${"z".repeat(32)}` });
  await expectSocketRejected(invalidOrigin);

  invalidExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await expectSocketRejected(invalidExtension);

  malformedExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  await onceOpen(malformedExtension);
  const malformedExtensionClosed = onceClose(malformedExtension);
  malformedExtension.send("{");
  assert((await malformedExtensionClosed).code === 1007, "invalid extension JSON did not close with 1007");

  staleExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  await onceOpen(staleExtension);
  const staleClosed = onceClose(staleExtension);
  staleExtension.send(JSON.stringify({
    type: "hello", role: "extension", protocol: 3, version: "0.14.0", extension_id: EXPECTED_EXTENSION_ID,
    capabilities: ["semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits"],
  }));
  const staleResult = await staleClosed;
  assert(staleResult.code === 1002 && staleResult.reason.includes("version mismatch"), "stale extension version was not rejected with reload guidance");
  const staleStatus = await owner.status();
  assert(staleStatus.connected === false && staleStatus.extension_reload_required === true, "stale extension rejection did not persist reload guidance");
  await waitFor(async () => (await client.status()).extension_reload_required === true);

  extension = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  const extensionReady = attachExtensionResponder(extension);
  await onceOpen(extension);
  await extensionReady;
  await waitFor(() => owner.extensionConnected());
  const connectedStatus = await owner.status();
  assert(connectedStatus.expected_extension_version === PACKAGE_VERSION && connectedStatus.extension_protocol === 3 && connectedStatus.extension_version === PACKAGE_VERSION, "extension handshake metadata was not exposed");
  assert(connectedStatus.expected_extension_id === EXPECTED_EXTENSION_ID && connectedStatus.extension_id === EXPECTED_EXTENSION_ID, "browser status omitted the pinned extension identity");
  assert(connectedStatus.security.pinned_extension_identity === true, "browser status did not advertise extension identity pinning");
  assert(connectedStatus.extension_reload_required === false, "compatible extension did not clear stale-build reload guidance");
  const healthUrl = new URL(initial.endpoint);
  healthUrl.protocol = "http:";
  healthUrl.pathname = "/healthz";
  const health = await (await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })).json();
  assert(health.connected === true && health.expected_extension_version === PACKAGE_VERSION && health.extension_protocol === 3 && health.extension_version === PACKAGE_VERSION, "browser health endpoint omitted authenticated extension metadata");
  assert(health.expected_extension_id === EXPECTED_EXTENSION_ID && health.extension_id === EXPECTED_EXTENSION_ID, "browser health endpoint omitted the pinned extension identity");
  assert(health.controls_extension_profile === true && health.machine_bridge_launches_browser === false, "browser health endpoint omitted the extension-profile execution model");
  assert(health.profile_identity_verifiable === false, "browser health endpoint falsely claimed it can identify the daily browser profile");
  extension.send(JSON.stringify({ type: "ping" }));

  const tabs = await owner.listTabs({});
  assert(tabs.tabs[0].id === 7, "owner browser request was not routed to the extension");

  const compatibleSocket = owner.socket;
  staleReplacement = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  await onceOpen(staleReplacement);
  const staleReplacementClosed = onceClose(staleReplacement);
  staleReplacement.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, version: "0.13.0", extension_id: EXPECTED_EXTENSION_ID, capabilities: [] }));
  assert((await staleReplacementClosed).code === 1002, "incompatible replacement extension was not rejected");
  assert((await owner.status()).extension_reload_required === true, "stale replacement did not retain reload guidance while the compatible extension stayed active");
  assert(owner.socket === compatibleSocket && owner.extensionConnected(), "incompatible extension candidate displaced the compatible connection");
  assert((await owner.listTabs({})).tabs[0].id === 7, "compatible extension stopped serving requests after a stale replacement attempt");

  const managed = await owner.manageTabs({ action: "new", url: "https://example.test/form", active: false });
  assert(managed.action === "new" && managed.url === "https://example.test/form", "browser tab-management request was not routed");
  const waited = await owner.wait({ selector: { ref: "e1" }, state: "visible", timeout_seconds: 2 });
  assert(waited.ok === true && waited.condition.state === "visible", "browser wait request was not routed");
  const acted = await owner.act({ action: "click", selector: { ref: "e1" }, input_mode: "trusted", element_timeout_seconds: 4 });
  assert(acted.input_mode === "trusted" && acted.value_exposed === false, "browser trusted-input request lost result semantics");
  await expectReject(owner.wait({}), "requires selector");

  await expectReject(owner.act({ action: "navigate", url: "javascript:alert(1)" }), "protocol must be http, https, or file");
  const oversizedFields = Array.from({ length: 33 }, (_, index) => ({ selector: { id: `field-${index}` }, value: "x".repeat(128 * 1024) }));
  await expectReject(owner.fillForm({ fields: oversizedFields }), "exceed 4 MiB total");
  await expectReject(owner.fillForm({ fields: [{ selector: { ref: "e1" }, action: "click", value: "must-not-be-sent" }] }), "value is not valid for action 'click'");
  await expectReject(owner.uploadFiles({ selector: { id: "file" }, resources: ["upload"], filenames: "not-an-array" }), "filenames must be an array");
  await expectReject(owner.uploadFiles({ selector: { id: "file" }, resources: ["upload"], filenames: ["../deceptive.txt"] }), "safe single-component filenames");
  await expectReject(owner.uploadFiles({ selector: { id: "file" }, resources: ["upload"], mime_types: ["text/plain\ninvalid"] }), "valid media types");
  const invalidTimeoutResponses = [];
  owner.handleRuntimeClientMessage({ readyState: 1, send: (value) => invalidTimeoutResponses.push(JSON.parse(value)) }, Buffer.from(JSON.stringify({ type: "request", id: "invalid-timeout", method: "list_tabs", timeout_ms: -1 })));
  assert(invalidTimeoutResponses[0]?.error === "invalid browser request timeout", "invalid broker timeout escaped event-handler validation");

  holdListTabs = true;
  const cancelled = owner.listTabs({}, { callId: "cancel-browser-call" });
  await waitFor(() => Boolean(heldRequestId));
  const cancelledId = heldRequestId;
  owner.cancelCall("cancel-browser-call");
  await expectReject(cancelled, "may already have completed");
  await waitFor(() => cancelledRequestId === cancelledId);
  assert(owner.pending.size === 0, "cancelled owner request remained pending");
  holdListTabs = false;
  heldRequestId = "";

  holdListTabs = true;
  const interruptedOwner = owner.listTabs({ timeout_seconds: 10 }).catch((error) => error);
  const interruptedClient = client.listTabs({ timeout_seconds: 10 }).catch((error) => error);
  await waitFor(() => owner.pending.size === 1 && owner.brokerDiagnostics().routed_requests === 1);
  const previousServerSocket = owner.socket;
  replacementExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  const replacementReady = attachExtensionResponder(replacementExtension);
  await onceOpen(replacementExtension);
  await replacementReady;
  await waitFor(() => owner.extensionConnected() && owner.socket !== previousServerSocket);
  assert((await owner.status()).extension_reload_required === false, "compatible replacement did not clear reload guidance");
  const ownerReplacementError = await interruptedOwner;
  const clientReplacementError = await interruptedClient;
  assert(String(ownerReplacementError?.message || ownerReplacementError).includes("replaced; retry"), "owner request was not rejected cleanly during extension replacement");
  assert(String(clientReplacementError?.message || clientReplacementError).includes("replaced; retry"), "proxied request was not rejected cleanly during extension replacement");
  assert(owner.pending.size === 0 && owner.brokerDiagnostics().routed_requests === 0, "extension replacement left stale routed requests");
  holdListTabs = false;
  heldRequestId = "";
  const replacementTabs = await owner.listTabs({});
  assert(replacementTabs.tabs[0].id === 7 && owner.socket !== previousServerSocket, "closing a superseded extension disrupted the replacement connection");

  const runtimeUrl = new URL(initial.endpoint);
  runtimeUrl.pathname = "/runtime";
  invalidRuntime = new WebSocket(runtimeUrl, [`mbm-runtime.${pairing.runtimeToken}`]);
  const invalidRuntimeOpened = onceOpen(invalidRuntime);
  const invalidRuntimeHello = onceMessage(invalidRuntime);
  await invalidRuntimeOpened;
  const runtimeHello = JSON.parse(Buffer.from(await invalidRuntimeHello).toString("utf8"));
  assert(runtimeHello.type === "hello" && runtimeHello.role === "runtime", "runtime broker did not send its handshake");
  assert(runtimeHello.extension_connected === true && runtimeHello.extension_info?.protocol === 3, "runtime handshake omitted compatible extension metadata");
  assert(runtimeHello.extension_info?.extension_id === EXPECTED_EXTENSION_ID, "runtime handshake omitted the pinned extension identity");
  const invalidRuntimeClosed = onceClose(invalidRuntime);
  invalidRuntime.send(JSON.stringify({ type: "unknown" }));
  assert((await invalidRuntimeClosed).code === 1002, "unknown runtime protocol message did not close with 1002");

  const clientStatus = await client.status();
  assert(clientStatus.broker_role === "client" && clientStatus.connected === true, "second runtime did not join the machine-level browser broker");
  assert(clientStatus.extension_protocol === 3 && clientStatus.extension_capabilities.includes("trusted_input"), "broker client lost extension capability metadata");
  const proxiedTabs = await client.listTabs({});
  assert(proxiedTabs.tabs[0].title === "Example", "broker client request was not proxied to the extension");

  holdListTabs = true;
  heldRequestId = "";
  await expectReject(client.listTabs({ timeout_seconds: 1 }), "timed out");
  await waitFor(() => owner.brokerDiagnostics().routed_requests === 0);
  holdListTabs = false;
  heldRequestId = "";

  const upload = await client.uploadFiles({ selector: { id: "file" }, resources: ["upload"] });
  assert(upload.file_count === 1 && upload.resource_contents_exposed === false, "file upload result exposed or lost resource semantics");
  assert(!JSON.stringify(upload).includes("file-data"), "file upload returned local file contents");

  const pair = await owner.pair({ open: false });
  assert(pair.opened_pairing_page === false && !JSON.stringify(pair).includes(pairing.extensionToken) && !JSON.stringify(pair).includes(pairing.runtimeToken), "pair tool exposed a broker credential");

  owner.stop();
  await waitFor(() => client.server !== null, 5000);
  const failover = await client.status();
  assert(failover.broker_role === "owner", "broker client did not take ownership after the original owner stopped");

  console.log("browser bridge test ok");
} finally {
  try { extension?.close(); } catch {}
  try { replacementExtension?.close(); } catch {}
  try { invalidOrigin?.close(); } catch {}
  try { invalidExtension?.close(); } catch {}
  try { malformedExtension?.close(); } catch {}
  try { staleExtension?.close(); } catch {}
  try { staleReplacement?.close(); } catch {}
  try { invalidRuntime?.close(); } catch {}
  client.stop();
  owner.stop();
  await rm(root, { recursive: true, force: true });
}


async function testStopDuringStart() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-start-race-"));
  const manager = new BrowserBridgeManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    stateRoot,
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  });
  let releaseListen;
  let markListening;
  let serverClosed = false;
  const listenBlocked = new Promise((resolvePromise) => { releaseListen = resolvePromise; });
  const listening = new Promise((resolvePromise) => { markListening = resolvePromise; });
  manager.listen = async () => {
    markListening();
    await listenBlocked;
    manager.server = { close() { serverClosed = true; } };
    manager.wss = { close() {} };
  };
  try {
    const starting = manager.ensureStarted();
    await listening;
    manager.stop();
    releaseListen();
    await expectReject(starting, "start cancelled");
    assert(serverClosed && manager.server === null && manager.wss === null, "browser bridge reopened a listener after stop raced with startup");
  } finally {
    manager.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
}


async function testStartFailureCleanup() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-start-failure-"));
  const manager = new BrowserBridgeManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    stateRoot,
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  });
  let serverClosed = false;
  manager.listen = async () => {
    manager.server = { close() { serverClosed = true; } };
    manager.wss = { close() {} };
    throw new Error("injected listen failure");
  };
  try {
    await expectReject(manager.ensureStarted(), "injected listen failure");
    assert(serverClosed && manager.server === null && manager.wss === null, "browser bridge retained partial transports after startup failure");
  } finally {
    manager.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function attachExtensionResponder(socket) {
  let handshakeStage = "broker-hello";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const timer = setTimeout(() => rejectReady(new Error("timed out waiting for extension handshake")), 5000);
  socket.once("error", rejectReady);
  socket.once("close", (code, reason) => {
    if (handshakeStage !== "ready") rejectReady(new Error(`extension closed during handshake (${code}: ${String(reason || "")})`));
  });
  socket.on("message", (data) => {
    const message = JSON.parse(Buffer.from(data).toString("utf8"));
    if (handshakeStage === "broker-hello") {
      assert(message.type === "hello" && message.role === "extension" && message.protocol === 3, "broker extension hello was invalid");
      handshakeStage = "broker-ack";
      socket.send(JSON.stringify({
        type: "hello", role: "extension", protocol: 3, version: PACKAGE_VERSION, extension_id: EXPECTED_EXTENSION_ID,
        capabilities: ["semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits"],
      }));
      return;
    }
    if (handshakeStage === "broker-ack") {
      assert(message.type === "hello_ack" && message.role === "extension" && message.protocol === 3, "broker extension acknowledgement was invalid");
      handshakeStage = "ready";
      clearTimeout(timer);
      resolveReady();
      return;
    }
    if (message.type === "cancel") {
      cancelledRequestId = message.id;
      return;
    }
    if (message.type !== "request") return;
    if (message.method === "list_tabs") {
      if (holdListTabs) {
        heldRequestId = message.id;
        return;
      }
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { tabs: [{ id: 7, title: "Example", url: "https://example.test/" }] } }));
      return;
    }
    if (message.method === "manage_tabs") {
      assert(message.params.action === "new" && message.params.active === false, "tab-management parameters were not normalized");
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { action: "new", url: message.params.url } }));
      return;
    }
    if (message.method === "wait") {
      assert(message.params.selector.ref === "e1" && message.params.timeoutMs === 2000, "browser wait parameters were not normalized");
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ok: true, condition: { state: message.params.state } } }));
      return;
    }
    if (message.method === "action") {
      assert(message.params.selector.ref === "e1" && message.params.inputMode === "trusted" && message.params.elementTimeoutMs === 4000, "trusted browser action parameters were not normalized");
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ok: true, input_mode: "trusted" } }));
      return;
    }
    if (message.method === "upload_files") {
      const file = message.params.files[0];
      assert(Buffer.from(file.data, "base64").toString("utf8") === "file-data", "registered file resource was not transferred to the extension");
      assert(file.filename === "upload.txt" && file.mime === "application/octet-stream", "browser upload metadata was not normalized");
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ok: true, file_count: 1, values_exposed: false } }));
      return;
    }
    socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: "unexpected method" }));
  });
  return ready;
}

async function expectReject(promise, expected) {
  try { await promise; } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}

function onceOpen(socket, timeoutMs = 5000) {
  return waitForSocketEvent(socket, "open", timeoutMs, "open", (resolvePromise) => () => resolvePromise());
}

function onceMessage(socket, timeoutMs = 5000) {
  return waitForSocketEvent(socket, "message", timeoutMs, "message", (resolvePromise) => (data) => resolvePromise(data));
}

function onceClose(socket, timeoutMs = 5000) {
  return waitForSocketEvent(socket, "close", timeoutMs, "close", (resolvePromise) => (code, reason) => {
    resolvePromise({ code, reason: String(reason || "") });
  }, { rejectOnError: false });
}

function waitForSocketEvent(socket, event, timeoutMs, label, createListener, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const rejectOnError = options.rejectOnError !== false;
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`timed out waiting for browser socket ${label}`));
    }, timeoutMs);
    const listener = createListener((value) => { cleanup(); resolvePromise(value); });
    const onError = (error) => {
      if (!rejectOnError) return;
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, listener);
      socket.off("error", onError);
    };
    socket.once(event, listener);
    socket.on("error", onError);
  });
}

function expectSocketRejected(socket) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("unauthorized browser socket was not rejected")), 2000);
    const done = () => { clearTimeout(timer); resolvePromise(); };
    socket.once("unexpected-response", done);
    socket.once("close", done);
    socket.once("open", () => { clearTimeout(timer); rejectPromise(new Error("unauthorized browser socket opened")); });
    socket.once("error", () => {});
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  throw new Error("timed out waiting for browser bridge state");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
