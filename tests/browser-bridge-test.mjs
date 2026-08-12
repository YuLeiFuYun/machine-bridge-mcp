import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { BrowserBridgeManager } from "../src/local/browser-bridge.mjs";
import { BrowserBrokerRoutes } from "../src/local/browser-broker-routes.mjs";
import { BrowserRequestRegistry } from "../src/local/browser-request-registry.mjs";
import { BridgeError } from "../src/local/errors.mjs";
import { EXPECTED_EXTENSION_ID } from "../src/local/browser-extension-identity.mjs";
import { BROKER_AUTH_REQUEST_HEADER, BROKER_AUTH_REQUEST_VALUE, createBrokerAuthChallenge, createBrokerClientProtocol, createBrokerInitProof, parseBrokerAuthResponse, verifyBrokerServerProof } from "../src/local/browser-broker-auth.mjs";
import { createPairingBootstrapInitProof, createPairingBootstrapProof, parseBrowserPairingGrant } from "../src/local/browser-pairing-grant.mjs";

const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const BROWSER_FIXTURE_WAIT_MS = 30_000;


await testBrowserRequestSettlementEvidence();
await testStopDuringStart();
await testStartFailureCleanup();
await testAuthenticatedProxyHandshakeFailure();
await testRuntimeProxyRejectsForgedServerProof();
await testPreviousPairingMigrationRefusesSecondOwner();

const root = await mkdtemp(join(tmpdir(), "mbm-browser-bridge-"));
if (process.platform !== "win32") await chmod(root, 0o777);
const policy = { profile: "full", execMode: "shell", unrestrictedPaths: true };
let openedPairUrl = "";
const common = {
  policy,
  stateRoot: root,
  runProcess: async (_command, argv) => { openedPairUrl = argv.find((value) => String(value).startsWith("http://127.0.0.1:")) || openedPairUrl; return { code: 0, stdout: "", stderr: "" }; },
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
  assert(pairing.schemaVersion === 2 && pairing.pairingAuthVersion === 2 && pairing.extensionToken !== pairing.runtimeToken, "browser pairing state did not separate extension and runtime credentials");
  assert(!JSON.stringify(initial).includes(pairing.extensionToken) && !JSON.stringify(initial).includes(pairing.runtimeToken), "browser status exposed a pairing credential");
  const response = await fetch(initial.pairing_url, { signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS) });
  const html = await response.text();
  assert(response.status === 200 && !html.includes(pairing.extensionToken), "sanitized local pairing page exposed the long-lived extension token");
  assert(html.includes("Expected extension build") && html.includes(PACKAGE_VERSION), "local pairing page omitted extension reload diagnostics");
  assert(html.includes("Expected extension ID") && html.includes(EXPECTED_EXTENSION_ID), "local pairing page omitted the pinned extension identity");
  assert(response.headers.get("cache-control") === "no-store", "pairing page is cacheable");
  assert(!html.includes(pairing.runtimeToken), "local pairing page exposed the owner-only runtime credential");
  const pairLaunch = await owner.pair({ open: true });
  assert(pairLaunch.pairing_url === initial.pairing_url && !pairLaunch.pairing_url.includes("grant="), "public pairing result exposed an internal pairing grant");
  const internalPairUrl = new URL(openedPairUrl);
  const launchFragment = internalPairUrl.hash.startsWith("#") ? new URLSearchParams(internalPairUrl.hash.slice(1)) : null;
  const brokerPort = Number(launchFragment?.get("broker_port"));
  assert(internalPairUrl.pathname === "/pair" && !internalPairUrl.search && launchFragment?.size === 2
    && Number.isInteger(brokerPort) && brokerPort === pairing.port && Number(internalPairUrl.port) !== brokerPort
    && !openedPairUrl.includes(pairing.extensionToken) && !openedPairUrl.includes(pairing.runtimeToken),
  "internal pairing launch did not isolate the short-lived bootstrap on a separate loopback listener");
  const grant = String(launchFragment?.get("grant") || "");
  const parsedGrant = parseBrowserPairingGrant(grant);
  assert(parsedGrant?.id && parsedGrant?.secret, "internal pairing launch URL contained an invalid bootstrap grant");
  internalPairUrl.hash = "";
  const grantedHtml = await (await fetch(internalPairUrl, { signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS) })).text();
  assert(!grantedHtml.includes(pairing.extensionToken) && !grantedHtml.includes(pairing.runtimeToken) && !grantedHtml.includes(parsedGrant.secret),
    "token-free pairing document exposed a long-lived credential or fragment secret");

  const pairChallenge = createBrokerAuthChallenge();
  const pairAuthUrl = new URL(`http://127.0.0.1:${brokerPort}/pair-auth`);
  pairAuthUrl.searchParams.set("grant", parsedGrant.id);
  pairAuthUrl.searchParams.set("challenge", pairChallenge);
  pairAuthUrl.searchParams.set("init", createPairingBootstrapInitProof(parsedGrant.secret, parsedGrant.id, pairChallenge));
  const pairProofResponse = await fetch(pairAuthUrl, {
    method: "GET", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
    signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS),
  });
  const pairProof = parseBrokerAuthResponse(pairProofResponse.headers);
  assert(pairProofResponse.status === 204 && pairProof
    && pairProof.serverProof === createPairingBootstrapProof(parsedGrant.secret, "server", parsedGrant.id, pairChallenge, pairProof.serverNonce),
  "pairing bootstrap did not authenticate the broker with the fragment secret");
  const forgedPairAuth = new URL(`http://127.0.0.1:${brokerPort}/pair-auth`);
  forgedPairAuth.searchParams.set("grant", `${Date.now() + 30_000}.${"f".repeat(22)}`);
  forgedPairAuth.searchParams.set("challenge", createBrokerAuthChallenge());
  forgedPairAuth.searchParams.set("init", "f".repeat(43));
  const forgedPairResponse = await fetch(forgedPairAuth, {
    method: "GET", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
    signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS),
  });
  assert(forgedPairResponse.status === 401, "fabricated pairing grant id consumed a broker bootstrap slot without fragment proof");
  pairAuthUrl.searchParams.set("nonce", pairProof.serverNonce);
  pairAuthUrl.searchParams.set("proof", createPairingBootstrapProof(parsedGrant.secret, "client", parsedGrant.id, pairChallenge, pairProof.serverNonce));
  const pairCredentialResponse = await fetch(pairAuthUrl, {
    method: "POST", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
    signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS),
  });
  assert(pairCredentialResponse.status === 204
    && pairCredentialResponse.headers.get("x-machine-bridge-extension-token") === pairing.extensionToken,
  "authenticated pairing bootstrap did not release the extension credential");
  const replayResponse = await fetch(pairAuthUrl, {
    method: "POST", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
    signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS),
  });
  assert(replayResponse.status === 401, "one-time pairing bootstrap replayed successfully");

  const unauthenticatedChallenge = new URL(initial.endpoint);
  unauthenticatedChallenge.protocol = "http:";
  unauthenticatedChallenge.pathname = "/runtime-auth";
  unauthenticatedChallenge.search = `?challenge=${encodeURIComponent(createBrokerAuthChallenge())}`;
  const unauthenticatedResponse = await fetch(unauthenticatedChallenge, { signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS) });
  assert(unauthenticatedResponse.status === 403, "browser broker issued an auth challenge without the internal request marker");
  const unprovedChallenge = createBrokerAuthChallenge();
  unauthenticatedChallenge.search = `?challenge=${encodeURIComponent(unprovedChallenge)}`;
  const unprovedResponse = await fetch(unauthenticatedChallenge, {
    headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE },
    signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS),
  });
  assert(unprovedResponse.status === 400, "browser broker allocated a normal auth challenge before client HMAC proof");

  const tokenRoleRuntimeUrl = new URL(initial.endpoint);
  tokenRoleRuntimeUrl.pathname = "/runtime";
  await expectSocketRejected(new WebSocket(tokenRoleRuntimeUrl, [`mbm-runtime.${pairing.extensionToken}`]));
  await expectSocketRejected(new WebSocket(tokenRoleRuntimeUrl, [`mbm-runtime.${pairing.runtimeToken}`]));
  await expectSocketRejected(new WebSocket(initial.endpoint, [`mbm.${pairing.runtimeToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` }));
  await expectSocketRejected(new WebSocket(initial.endpoint, [`mbm.${pairing.extensionToken}`], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` }));

  const rejected = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: "https://example.test" });
  await expectSocketRejected(rejected);
  invalidOrigin = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${"z".repeat(32)}` });
  await expectSocketRejected(invalidOrigin);

  invalidExtension = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await expectSocketRejected(invalidExtension);

  malformedExtension = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
  await onceOpen(malformedExtension);
  const malformedExtensionClosed = onceClose(malformedExtension);
  malformedExtension.send("{");
  assert((await malformedExtensionClosed).code === 1007, "invalid extension JSON did not close with 1007");

  staleExtension = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
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

  extension = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
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
  const health = await (await fetch(healthUrl, { signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS) })).json();
  assert(health.connected === true && health.expected_extension_version === PACKAGE_VERSION && health.extension_protocol === 3 && health.extension_version === PACKAGE_VERSION, "browser health endpoint omitted authenticated extension metadata");
  assert(health.expected_extension_id === EXPECTED_EXTENSION_ID && health.extension_id === EXPECTED_EXTENSION_ID, "browser health endpoint omitted the pinned extension identity");
  assert(health.controls_extension_profile === true && health.machine_bridge_launches_browser === false, "browser health endpoint omitted the extension-profile execution model");
  assert(health.profile_identity_verifiable === false, "browser health endpoint falsely claimed it can identify the daily browser profile");
  extension.send(JSON.stringify({ type: "ping" }));

  const tabs = await owner.listTabs({});
  assert(tabs.tabs[0].id === 7, "owner browser request was not routed to the extension");

  const compatibleSocket = owner.socket;
  staleReplacement = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
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
  await expectReject(cancelled, "browser request cancelled");
  await waitFor(() => cancelledRequestId === cancelledId);
  assert(owner.pending.size === 0, "cancelled owner request remained pending");
  holdListTabs = false;
  heldRequestId = "";

  holdListTabs = true;
  const interruptedOwner = owner.listTabs({ timeout_seconds: 10 }).catch((error) => error);
  const interruptedClient = client.listTabs({ timeout_seconds: 10 }).catch((error) => error);
  await waitFor(() => owner.pending.size === 1 && owner.brokerDiagnostics().routed_requests === 1);
  const previousServerSocket = owner.socket;
  replacementExtension = new WebSocket(initial.endpoint, [await brokerProtocol(initial.endpoint, pairing.extensionToken, "extension")], { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` });
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
  invalidRuntime = new WebSocket(runtimeUrl, [await runtimeProtocol(initial.endpoint, pairing.runtimeToken)]);
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
  await waitFor(() => client.server !== null);
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


async function testBrowserRequestSettlementEvidence() {
  const sent = [];
  const transport = { send(value) { sent.push(JSON.parse(value)); } };
  const registry = new BrowserRequestRegistry();
  const mutation = registry.request({ transport, method: "action", params: {}, timeoutSeconds: 60, callId: "mutation-timeout" });
  registry.cancelCall("mutation-timeout", transport, new BridgeError("timeout", "tool call timed out"));
  let mutationError;
  try { await mutation; } catch (error) { mutationError = error; }
  assert(mutationError instanceof BridgeError && mutationError.code === "timeout" && mutationError.retryable === false,
    "browser mutation deadline lost its timeout identity or became safely retryable");
  assert(mutationError.details?.request_delivery === "sent" && mutationError.details?.side_effects_started === "unknown"
    && mutationError.details?.termination_requested === true && mutationError.details?.effect_settlement === "pending",
  "browser mutation deadline overstated or omitted post-dispatch settlement evidence");
  assert(sent.some((message) => message.type === "cancel"), "browser mutation deadline did not send a cancellation frame");

  const read = registry.request({ transport, method: "list_tabs", params: {}, timeoutSeconds: 60, callId: "read-disconnect" });
  registry.rejectAll("browser extension disconnected");
  let readError;
  try { await read; } catch (error) { readError = error; }
  assert(readError instanceof BridgeError && readError.code === "unavailable" && readError.retryable === true && !readError.details,
    "read-only browser disconnect was not safely distinguishable from an ambiguous mutation");

  const mutationDisconnect = registry.request({ transport, method: "fill_form", params: {}, timeoutSeconds: 60, callId: "mutation-disconnect" });
  registry.rejectAll("browser extension disconnected");
  let disconnectError;
  try { await mutationDisconnect; } catch (error) { disconnectError = error; }
  assert(disconnectError instanceof BridgeError && disconnectError.code === "unavailable" && disconnectError.retryable === false
    && disconnectError.details?.request_delivery === "sent" && disconnectError.details?.termination_requested === false
    && disconnectError.details?.effect_settlement === "unknown",
  "browser mutation disconnect invited an unsafe retry or invented cancellation delivery");

  const partial = registry.request({ transport, method: "action", params: {}, timeoutSeconds: 60, callId: "partial-action" });
  const partialId = sent.at(-1)?.id;
  assert(registry.settle({ type: "response", id: partialId, ok: false, error: "trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying." }),
    "browser partial-action fixture did not settle its request");
  let partialError;
  try { await partial; } catch (error) { partialError = error; }
  assert(partialError instanceof BridgeError && partialError.retryable === false
    && partialError.details?.side_effects_started === true && partialError.details?.effect_settlement === "unknown",
  "extension-proven partial browser input lost its structured side-effect evidence");

  const clientMessages = [];
  const extensionMessages = [];
  const clientSocket = { readyState: 1, send(value) { clientMessages.push(JSON.parse(value)); }, close() {} };
  const extensionSocket = { readyState: 1, send(value) { extensionMessages.push(JSON.parse(value)); } };
  const routes = new BrowserBrokerRoutes({
    maximum: 8,
    getExtensionSocket: () => extensionSocket,
    extensionConnected: () => true,
    extensionStatusInfo: () => null,
    extensionReloadRequired: () => false,
  });
  routes.handleClientMessage(clientSocket, JSON.stringify({ type: "request", id: "proxy-action", method: "action", params: {}, timeout_ms: 1000 }));
  assert(extensionMessages.at(-1)?.method === "action", "browser broker did not forward the mutating proxy request");
  routes.rejectAll("browser extension was replaced; retry the browser request");
  const brokerError = clientMessages.at(-1)?.error || "";
  assert(brokerError.includes("outcome is unknown") && !brokerError.includes("retry the browser request"),
    "browser broker proxy told a mixed-version client to blindly retry an already-dispatched mutation");

  const proxyRegistry = new BrowserRequestRegistry();
  const proxySent = [];
  const proxyMutation = proxyRegistry.request({ transport: { send(value) { proxySent.push(JSON.parse(value)); } }, method: "action", params: {}, timeoutSeconds: 60, callId: "proxy-action" });
  assert(proxyRegistry.settle({ type: "response", id: proxySent.at(-1)?.id, ok: false, error: brokerError }),
    "browser proxy mutation error did not settle the current client request");
  let proxyError;
  try { await proxyMutation; } catch (error) { proxyError = error; }
  assert(proxyError instanceof BridgeError && proxyError.code === "unavailable" && proxyError.retryable === false
    && proxyError.details?.effect_settlement === "unknown",
  "current browser proxy client lost the broker's ambiguous-mutation semantics");
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


async function testAuthenticatedProxyHandshakeFailure() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-authenticated-proxy-race-"));
  const common = {
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    stateRoot,
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  };
  const owner = new BrowserBridgeManager(common);
  const contender = new BrowserBridgeManager(common);
  try {
    await owner.ensureStarted();
    const ownerPort = owner.port;
    owner.brokerRoutes.acceptClient = (socket) => {
      owner.brokerRoutes.clients.add(socket);
      socket.on("close", () => owner.brokerRoutes.clients.delete(socket));
    };
    await expectReject(contender.ensureStarted(), "accepted runtime authentication but did not complete its handshake");
    assert(contender.server === null && contender.upstream === null,
      "browser bridge created a second owner after authenticating to an unready peer");
    const pairing = JSON.parse(await readFile(join(stateRoot, "browser-bridge.json"), "utf8"));
    assert(pairing.port === ownerPort, "failed authenticated proxy handshake rewrote the shared pairing port");
  } finally {
    contender.stop();
    owner.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
}


async function testPreviousPairingMigrationRefusesSecondOwner() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-previous-owner-"));
  if (process.platform !== "win32") await chmod(stateRoot, 0o700);
  const blocker = createServer((_request, response) => response.writeHead(404).end());
  await new Promise((resolvePromise, rejectPromise) => {
    blocker.once("error", rejectPromise);
    blocker.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = blocker.address().port;
  const oldExtensionToken = "e".repeat(43);
  const oldRuntimeToken = "r".repeat(43);
  await writeFile(join(stateRoot, "browser-bridge.json"), `${JSON.stringify({ schemaVersion: 2, extensionToken: oldExtensionToken, runtimeToken: oldRuntimeToken, port })}\n`, { mode: 0o600 });
  const manager = new BrowserBridgeManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    stateRoot,
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  });
  try {
    await expectReject(manager.ensureStarted(), "previous browser broker occupies the migrated pairing port");
    assert(manager.server === null && manager.upstream === null, "previous-owner pairing migration created or retained a second broker transport");
    const persisted = JSON.parse(await readFile(join(stateRoot, "browser-bridge.json"), "utf8"));
    assert(persisted.schemaVersion === 2 && persisted.pairingAuthVersion === 2 && persisted.migrationPending === true, "failed mixed-version migration forgot its pending safety state");
    assert(persisted.runtimeToken === oldRuntimeToken, "mixed-version migration changed the runtime HMAC key before the old owner stopped");
    assert(persisted.extensionToken !== oldExtensionToken, "previous-state migration retained the extension token exposed by the prior pairing page");
    const second = new BrowserBridgeManager({
      policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
      stateRoot,
      runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
      readResourceText: async () => "",
      readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
    });
    try {
      await expectReject(second.ensureStarted(), "previous browser broker occupies the migrated pairing port");
      assert(second.server === null && second.upstream === null, "persisted pending migration allowed a later process to create a second broker owner");
    } finally { second.stop(); }
  } finally {
    manager.stop();
    await new Promise((resolvePromise) => { blocker.close(resolvePromise); });
    await rm(stateRoot, { recursive: true, force: true });
  }
}


async function testRuntimeProxyRejectsForgedServerProof() {
  let upgradeSeen = false;
  let requestText = "";
  const server = createServer((request, response) => {
    requestText += `${request.method} ${request.url} ${JSON.stringify(request.headers)}\n`;
    response.writeHead(204, {
      "cache-control": "no-store",
      "x-machine-bridge-runtime-nonce": "n".repeat(32),
      "x-machine-bridge-runtime-proof": "p".repeat(43),
    }).end();
  });
  server.on("upgrade", (request, socket) => {
    upgradeSeen = true;
    requestText += `UPGRADE ${request.url} ${JSON.stringify(request.headers)}\n`;
    socket.destroy();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  const runtimeToken = "r".repeat(43);
  const manager = new BrowserBridgeManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  });
  manager.runtimeToken = runtimeToken;
  try {
    const result = await manager.connectProxy(port);
    assert(result.connected === false && result.authenticated === false, "forged runtime broker proof was accepted");
    assert(upgradeSeen === false, "runtime bearer protocol was sent before broker proof verification");
    assert(!requestText.includes(runtimeToken), "long-lived runtime credential leaked to an unproven local port owner");
  } finally {
    manager.stop();
    await new Promise((resolvePromise) => { server.close(resolvePromise); });
  }
}

async function runtimeProtocol(endpoint, runtimeToken) {
  return brokerProtocol(endpoint, runtimeToken, "runtime");
}

async function brokerProtocol(endpoint, token, role) {
  const challenge = createBrokerAuthChallenge();
  const url = new URL(endpoint);
  url.protocol = "http:";
  url.pathname = `/${role}-auth`;
  const initProof = createBrokerInitProof(token, role, challenge);
  url.search = `?challenge=${encodeURIComponent(challenge)}&init=${encodeURIComponent(initProof)}`;
  const response = await fetch(url, { redirect: "error", cache: "no-store", headers: { [BROKER_AUTH_REQUEST_HEADER]: BROKER_AUTH_REQUEST_VALUE }, signal: AbortSignal.timeout(BROWSER_FIXTURE_WAIT_MS) });
  assert(response.status === 204, "runtime broker auth challenge was not accepted");
  const auth = parseBrokerAuthResponse(response.headers);
  assert(auth && verifyBrokerServerProof(token, role, challenge, auth.serverNonce, auth.serverProof), `${role} broker server proof was invalid`);
  return createBrokerClientProtocol(token, role, challenge, auth.serverNonce);
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
  const timer = setTimeout(() => rejectReady(new Error("timed out waiting for extension handshake")), BROWSER_FIXTURE_WAIT_MS);
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

function onceOpen(socket, timeoutMs = BROWSER_FIXTURE_WAIT_MS) {
  return waitForSocketEvent(socket, "open", timeoutMs, "open", (resolvePromise) => () => resolvePromise());
}

function onceMessage(socket, timeoutMs = BROWSER_FIXTURE_WAIT_MS) {
  return waitForSocketEvent(socket, "message", timeoutMs, "message", (resolvePromise) => (data) => resolvePromise(data));
}

function onceClose(socket, timeoutMs = BROWSER_FIXTURE_WAIT_MS) {
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
    const timer = setTimeout(() => rejectPromise(new Error("unauthorized browser socket was not rejected")), BROWSER_FIXTURE_WAIT_MS);
    const done = () => { clearTimeout(timer); resolvePromise(); };
    socket.once("unexpected-response", done);
    socket.once("close", done);
    socket.once("open", () => { clearTimeout(timer); rejectPromise(new Error("unauthorized browser socket opened")); });
    socket.once("error", () => {});
  });
}

async function waitFor(predicate, timeoutMs = BROWSER_FIXTURE_WAIT_MS) {
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
