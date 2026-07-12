import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BrowserBridgeManager } from "../src/local/browser-bridge.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-browser-bridge-"));
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
let invalidExtension;
let invalidRuntime;
let holdListTabs = false;
let heldRequestId = "";
let cancelledRequestId = "";
try {
  const initial = await owner.status();
  assert(initial.broker_role === "owner", "first browser bridge did not become owner");
  assert(initial.connected === false, "browser bridge unexpectedly reported an extension");
  assert(initial.pairing_url.endsWith("/pair") && !initial.pairing_url.includes("#"), "pairing token leaked through the URL fragment");

  const pairing = JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"));
  assert(!JSON.stringify(initial).includes(pairing.token), "browser status exposed the pairing token");
  const response = await fetch(initial.pairing_url, { signal: AbortSignal.timeout(5000) });
  const html = await response.text();
  assert(response.status === 200 && html.includes(pairing.token), "local pairing page did not contain the local-only token");
  assert(response.headers.get("cache-control") === "no-store", "pairing page is cacheable");

  const rejected = new WebSocket(initial.endpoint, [`mbm.${pairing.token}`], { origin: "https://example.test" });
  await expectSocketRejected(rejected);

  invalidExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.token}`], { origin: "chrome-extension://invalid-test" });
  await onceOpen(invalidExtension);
  const invalidExtensionClosed = onceClose(invalidExtension);
  invalidExtension.send("{");
  assert((await invalidExtensionClosed).code === 1007, "invalid extension JSON did not close with 1007");

  extension = new WebSocket(initial.endpoint, [`mbm.${pairing.token}`], { origin: "chrome-extension://synthetic-test" });
  await onceOpen(extension);
  attachExtensionResponder(extension);
  await waitFor(() => owner.socket?.readyState === 1);

  const tabs = await owner.listTabs({});
  assert(tabs.tabs[0].id === 7, "owner browser request was not routed to the extension");

  await expectReject(owner.act({ action: "navigate", url: "javascript:alert(1)" }), "protocol must be http, https, or file");
  const oversizedFields = Array.from({ length: 33 }, (_, index) => ({ selector: { id: `field-${index}` }, value: "x".repeat(128 * 1024) }));
  await expectReject(owner.fillForm({ fields: oversizedFields }), "exceed 4 MiB total");
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

  const previousServerSocket = owner.socket;
  replacementExtension = new WebSocket(initial.endpoint, [`mbm.${pairing.token}`], { origin: "chrome-extension://replacement-test" });
  await onceOpen(replacementExtension);
  attachExtensionResponder(replacementExtension);
  await waitFor(() => owner.socket?.readyState === 1 && owner.socket !== previousServerSocket);
  const replacementTabs = await owner.listTabs({});
  assert(replacementTabs.tabs[0].id === 7 && owner.socket !== previousServerSocket, "closing a superseded extension disrupted the replacement connection");

  const runtimeUrl = new URL(initial.endpoint);
  runtimeUrl.pathname = "/runtime";
  invalidRuntime = new WebSocket(runtimeUrl, [`mbm-runtime.${pairing.token}`]);
  const invalidRuntimeOpened = onceOpen(invalidRuntime);
  const invalidRuntimeHello = onceMessage(invalidRuntime);
  await invalidRuntimeOpened;
  const runtimeHello = JSON.parse(Buffer.from(await invalidRuntimeHello).toString("utf8"));
  assert(runtimeHello.type === "hello" && runtimeHello.role === "runtime", "runtime broker did not send its handshake");
  const invalidRuntimeClosed = onceClose(invalidRuntime);
  invalidRuntime.send(JSON.stringify({ type: "unknown" }));
  assert((await invalidRuntimeClosed).code === 1002, "unknown runtime protocol message did not close with 1002");

  const clientStatus = await client.status();
  assert(clientStatus.broker_role === "client" && clientStatus.connected === true, "second runtime did not join the machine-level browser broker");
  const proxiedTabs = await client.listTabs({});
  assert(proxiedTabs.tabs[0].title === "Example", "broker client request was not proxied to the extension");

  holdListTabs = true;
  heldRequestId = "";
  await expectReject(client.listTabs({ timeout_seconds: 1 }), "timed out");
  await waitFor(() => owner.proxyRoutes.size === 0);
  holdListTabs = false;
  heldRequestId = "";

  const upload = await client.uploadFiles({ selector: { id: "file" }, resources: ["upload"] });
  assert(upload.file_count === 1 && upload.resource_contents_exposed === false, "file upload result exposed or lost resource semantics");
  assert(!JSON.stringify(upload).includes("file-data"), "file upload returned local file contents");

  const pair = await owner.pair({ open: false });
  assert(pair.opened_pairing_page === false && !JSON.stringify(pair).includes(pairing.token), "pair tool exposed the pairing token");

  owner.stop();
  await waitFor(() => client.server !== null, 5000);
  const failover = await client.status();
  assert(failover.broker_role === "owner", "broker client did not take ownership after the original owner stopped");

  console.log("browser bridge test ok");
} finally {
  try { extension?.close(); } catch {}
  try { replacementExtension?.close(); } catch {}
  try { invalidExtension?.close(); } catch {}
  try { invalidRuntime?.close(); } catch {}
  client.stop();
  owner.stop();
  await rm(root, { recursive: true, force: true });
}

function attachExtensionResponder(socket) {
  socket.on("message", (data) => {
    const message = JSON.parse(Buffer.from(data).toString("utf8"));
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
    if (message.method === "upload_files") {
      const file = message.params.files[0];
      assert(Buffer.from(file.data, "base64").toString("utf8") === "file-data", "registered file resource was not transferred to the extension");
      assert(file.filename === "upload.txt" && file.mime === "application/octet-stream", "browser upload metadata was not normalized");
      socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ok: true, file_count: 1, values_exposed: false } }));
      return;
    }
    socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: "unexpected method" }));
  });
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
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("timed out waiting for browser bridge state");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
