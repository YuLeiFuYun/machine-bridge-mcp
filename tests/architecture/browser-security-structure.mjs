import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// These source-shape checks are supplemental architecture guards. Behavior and failure semantics are tested separately.
const localAutomationFiles = [
  join(root, "src", "local", "app-automation.mjs"),
  join(root, "src", "local", "app-automation-macos-jxa.mjs"),
  join(root, "src", "local", "browser-bridge.mjs"),
  join(root, "src", "local", "browser-operation-service.mjs"),
  join(root, "browser-extension", "service-worker.js"),
  join(root, "browser-extension", "broker-auth.js"),
  join(root, "browser-extension", "pairing-bootstrap.js"),
  join(root, "browser-extension", "browser-error-boundary.js"),
  join(root, "browser-extension", "browser-operations.js"),
  join(root, "browser-extension", "devtools-session.js"),
  join(root, "browser-extension", "devtools-input.js"),
  join(root, "browser-extension", "devtools-observation.js"),
  join(root, "browser-extension", "page-automation.js"),
  join(root, "browser-extension", "pairing.js"),
];
for (const file of localAutomationFiles) {
  const source = readFileSync(file, "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) {
    throw new Error(`arbitrary evaluation returned in ${relative(root, file)}`);
  }
}
const extensionManifest = JSON.parse(readFileSync(join(root, "browser-extension", "manifest.json"), "utf8"));
const extensionIdentitySource = readFileSync(join(root, "src", "local", "browser-extension-identity.mjs"), "utf8");
const brokerServerSource = readFileSync(join(root, "src", "local", "browser-broker-server.mjs"), "utf8");
if (extensionManifest.manifest_version !== 3 || !extensionManifest.permissions?.includes("scripting") || !extensionManifest.permissions?.includes("alarms") || !extensionManifest.permissions?.includes("debugger")) {
  throw new Error("packaged browser extension is missing required Manifest V3 capabilities");
}
const pairingContent = extensionManifest.content_scripts?.find((entry) => entry.js?.includes("pairing.js"));
if (pairingContent?.run_at !== "document_start") throw new Error("browser pairing content script must run at document_start before page scripts");
if (!extensionManifest.host_permissions?.includes("<all_urls>")) {
  throw new Error("browser extension no longer declares the generic page access documented by the security model");
}
if (typeof extensionManifest.key !== "string" || extensionManifest.key.length < 128) {
  throw new Error("browser extension no longer pins a stable manifest public key");
}
if (!extensionIdentitySource.includes("extensionIdFromPublicKey") || !extensionIdentitySource.includes("createHash(\"sha256\")")) {
  throw new Error("browser extension identity is no longer derived from the pinned public key");
}
if (!brokerServerSource.includes("isAllowedExtensionOrigin(origin, EXPECTED_EXTENSION_ID)")) {
  throw new Error("browser broker no longer pins WebSocket Origin to the packaged extension identity");
}
const serviceWorkerSource = readFileSync(join(root, "browser-extension", "service-worker.js"), "utf8");
const extensionBrokerAuthSource = readFileSync(join(root, "browser-extension", "broker-auth.js"), "utf8");
const pairingBootstrapSource = readFileSync(join(root, "browser-extension", "pairing-bootstrap.js"), "utf8");
const pairingContentSource = readFileSync(join(root, "browser-extension", "pairing.js"), "utf8");
const browserErrorBoundarySource = readFileSync(join(root, "browser-extension", "browser-error-boundary.js"), "utf8");
const browserOperationsSource = readFileSync(join(root, "browser-extension", "browser-operations.js"), "utf8");
const pageAutomationSource = readFileSync(join(root, "browser-extension", "page-automation.js"), "utf8");
const devtoolsInputSource = readFileSync(join(root, "browser-extension", "devtools-input.js"), "utf8");
const devtoolsObservationSource = readFileSync(join(root, "browser-extension", "devtools-observation.js"), "utf8");
const devtoolsSessionSource = readFileSync(join(root, "browser-extension", "devtools-session.js"), "utf8");
const localToolResultBoundarySource = readFileSync(join(root, "src", "local", "tool-result-boundary.mjs"), "utf8");
const browserRequestSettlementSource = readFileSync(join(root, "src", "local", "browser-request-settlement.mjs"), "utf8");
const localAutomationDocsSource = readFileSync(join(root, "docs", "LOCAL_AUTOMATION.md"), "utf8");
const architectureDocsSource = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
if (!pageAutomationSource.includes("snapshot_version: 3")
    || !localAutomationDocsSource.includes("`browser_inspect_page` returns snapshot version 3")
    || localAutomationDocsSource.includes("`browser_inspect_page` returns snapshot version 2")
    || !architectureDocsSource.includes("snapshot-version-3 semantics")
    || architectureDocsSource.includes("snapshot-version-2 semantics")) {
  throw new Error("browser snapshot version and architecture/local-automation documentation drifted apart");
}
const appAutomationSource = readFileSync(join(root, "src", "local", "app-automation.mjs"), "utf8");
const appAutomationJxaSource = readFileSync(join(root, "src", "local", "app-automation-macos-jxa.mjs"), "utf8");
const cliLocalAdminSource = readFileSync(join(root, "src", "local", "cli-local-admin.mjs"), "utf8");
const workerSource = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const workerReadyMessagesSource = readFileSync(join(root, "src", "worker", "daemon-ready-messages.ts"), "utf8");
const workerWebSocketProtocolSource = readFileSync(join(root, "src", "worker", "websocket-protocol.ts"), "utf8");
const workerObservabilitySource = readFileSync(join(root, "src", "worker", "observability.ts"), "utf8");
const workerOAuthControllerSource = readFileSync(join(root, "src", "worker", "oauth-controller.ts"), "utf8");
const workerOAuthPageSource = readFileSync(join(root, "src", "worker", "oauth-authorization-page.ts"), "utf8");
const workerHttpSource = readFileSync(join(root, "src", "worker", "http.ts"), "utf8");
const workerStaticRoutesSource = readFileSync(join(root, "src", "worker", "worker-static-routes.ts"), "utf8");
const oauthBrowserNavigationSource = readFileSync(join(root, "tests", "oauth-browser-navigation-test.mjs"), "utf8");
const workerToolTimeoutSource = readFileSync(join(root, "src", "worker", "tool-timeout.ts"), "utf8");
const sharedForegroundTimeoutSource = readFileSync(join(root, "src", "shared", "foreground-timeout.mjs"), "utf8");

if (!workerToolTimeoutSource.includes('from "../shared/foreground-timeout.mjs"')
    || !sharedForegroundTimeoutSource.includes('"browser_manage_tabs", "browser_wait", "browser_get_source"')
    || !sharedForegroundTimeoutSource.includes('"browser_screenshot", "browser_upload_files"')) {
  throw new Error("shared foreground timeout classification omits browser_upload_files or lost Worker ownership");
}
for (const origin of ["https://chatgpt.com", "https://grok.com", "https://x.com"]) {
  if (!workerHttpSource.includes(`"${origin}"`)) throw new Error(`Worker built-in browser origins omit ${origin}`);
}
if (workerHttpSource.includes('"https://chat.openai.com"')) throw new Error("Worker retained the removed ChatGPT browser origin");
if (!workerHttpSource.includes("BUILT_IN_BROWSER_ORIGIN_SET.has(origin)") || !workerHttpSource.includes("allowed.includes(origin)")) {
  throw new Error("Worker CORS validation no longer combines built-in and configured exact origins");
}
if (!workerSource.includes('mcpOriginRejection(request, base, this.env.MBM_ALLOWED_ORIGINS ?? "")')) {
  throw new Error("Durable Object no longer validates Origin on actual MCP endpoint requests");
}
if (workerSource.indexOf("this.mcp.handleControl(request, proxyMode)")
  > workerSource.indexOf("authorizeMcpRequest({")) {
  throw new Error("private modern cancellation again reuses the public OAuth/DPoP proof");
}
if (!workerStaticRoutesSource.includes('path === "/mcp"')
  || !workerStaticRoutesSource.includes("mcpOriginRejection(request, base, extraOrigins)")) {
  throw new Error("outer Worker no longer rejects invalid MCP origins before Durable Object routing");
}
if (!workerSource.includes('request.method === "OPTIONS"') || !workerSource.includes("corsPreflight(request, base, extraOrigins, workerToolParameterHeaders)")) {
  throw new Error("Worker no longer gates browser CORS preflight through the exact-origin policy");
}
if (!workerHttpSource.includes("authorizationFormActionSources(formActionOrigin)") || !workerHttpSource.includes("const sources = [url.origin]") || !workerHttpSource.includes("form-action ${formAction}")) {
  throw new Error("authorization HTML no longer constrains form navigation to normalized validated origins");
}
if (!workerHttpSource.includes('url.hostname === "consent.azure-apim.net"')
  || !workerHttpSource.includes('url.hostname.endsWith(".consent.azure-apim.net")')
  || !workerHttpSource.includes('sources.push("https://*.consent.azure-apim.net", "https://copilotstudio.microsoft.com")')) {
  throw new Error("authorization HTML no longer permits only validated Microsoft consent callbacks to use the complete Power Platform callback chain");
}
if (!workerOAuthControllerSource.includes("./oauth-authorization-page.ts")
    || !workerOAuthPageSource.includes("new URL(authorization.redirectUri).origin")
    || !workerOAuthPageSource.includes("status, redirectOrigin")) {
  throw new Error("authorization pages no longer bind CSP form navigation to the validated redirect origin");
}
if (!oauthBrowserNavigationSource.includes("negative control reached the first callback")
  || !oauthBrowserNavigationSource.includes("first-hop-only policy unexpectedly followed the regional redirect")
  || !oauthBrowserNavigationSource.includes("regional-only policy unexpectedly followed the final Copilot Studio redirect")
  || !oauthBrowserNavigationSource.includes("authorization callback omitted code")
  || !oauthBrowserNavigationSource.includes("authorization state was not preserved")) {
  throw new Error("real-browser OAuth callback regression lost its first-hop, regional-hop, final-hop, or callback assertions");
}
if (!cliLocalAdminSource.includes('readBrowserPairingPort(state.paths.stateRoot)')
    || cliLocalAdminSource.includes("readBoundedRegularFileSync(pairingFile")
    || cliLocalAdminSource.includes("function readBrowserPairingState")) {
  throw new Error("browser CLI regained a duplicate pairing-state parser instead of the pairing-store projection");
}
const pairingStoreSource = readFileSync(join(root, "src", "local", "browser-pairing-store.mjs"), "utf8");
for (const required of ["export function readBrowserPairingPort", "readPairing(file)", "verifyPathIdentity: true", "rejectMultipleLinks: true"]) {
  if (!pairingStoreSource.includes(required)) throw new Error(`browser pairing-store projection lost secure bounded-state ownership: ${required}`);
}
if (!appAutomationSource.includes('from "./app-automation-macos-jxa.mjs"')) {
  throw new Error("application automation orchestration lost its dedicated macOS JXA implementation boundary");
}
if (!appAutomationJxaSource.includes("matchesList[payload.selector.index]")) {
  throw new Error("application UI selector index is not applied to the filtered match list");
}
if (!appAutomationJxaSource.includes("item.role === 'AXSecureTextField'") || !appAutomationJxaSource.includes("includeValues && !item.sensitive")) {
  throw new Error("application UI inspection does not suppress secure field values");
}
const fixedWorkerModules = [
  "browser-error-boundary.js", "broker-auth.js", "pairing-bootstrap.js", "devtools-session.js",
  "devtools-input.js", "devtools-observation.js", "browser-operations.js",
];
const importScriptsCall = serviceWorkerSource.match(/importScripts\(([^;]+)\);/)?.[0] || "";
if (!fixedWorkerModules.every((name) => importScriptsCall.includes(`"${name}"`))
    || /importScripts\([^"']/.test(importScriptsCall)) {
  throw new Error("browser service worker lost fixed browser module loading");
}
const stripIndex = pairingContentSource.indexOf("history.replaceState");
const bootstrapSendIndex = pairingContentSource.indexOf('sendMessage({ type: "pair_bootstrap"');
if (stripIndex < 0 || bootstrapSendIndex < 0 || stripIndex > bootstrapSendIndex) throw new Error("browser pairing bootstrap fragment is not stripped before extension messaging");
if (!pairingContentSource.includes("if (location.hash) return")) throw new Error("browser pairing proceeds when the bootstrap fragment remains page-visible");
if (!browserErrorBoundarySource.includes("__machineBridgeBrowserErrorBoundary")
    || !browserErrorBoundarySource.includes('return SAFE_EXACT.has(message) ? message : "browser operation failed"')) {
  throw new Error("browser error boundary no longer defaults unclassified exceptions to a fixed public message");
}
if (!browserOperationsSource.includes('files: ["page-automation.js"]')) {
  throw new Error("browser operations module does not inject the fixed page automation module");
}
if (!localToolResultBoundarySource.includes("MAX_TOOL_RESULT_BYTES = 7 * 1024 * 1024")
    || !serviceWorkerSource.includes("MAX_RESULT_BYTES = 7 * 1024 * 1024")) {
  throw new Error("local and browser-extension tool-result byte ceilings drifted apart");
}
if (!browserOperationsSource.includes("browser mutation may have completed; the action outcome is unknown because its result could not be delivered")
    || !browserRequestSettlementSource.includes('message.startsWith("browser mutation may have completed;")')) {
  throw new Error("browser mutation result-undeliverable settlement drifted across extension and broker layers");
}
if (serviceWorkerSource.split(/\r?\n/).length > 350) throw new Error("browser service worker regained page-operation responsibilities");
if (browserOperationsSource.split(/\r?\n/).length > 1900) throw new Error("browser operations exceeded its protocol/dispatch responsibility boundary");
if (pageAutomationSource.split(/\r?\n/).length > 1200) throw new Error("browser page automation exceeded its page-world responsibility boundary");
if (devtoolsInputSource.split(/\r?\n/).length > 330) throw new Error("browser DevTools input exceeded its trusted-input responsibility boundary");
if (devtoolsObservationSource.split(/\r?\n/).length > 440) throw new Error("browser DevTools observation exceeded its observation responsibility boundary");
if (devtoolsSessionSource.split(/\r?\n/).length > 50) throw new Error("browser DevTools session helper exceeded its serialization responsibility boundary");
if (extensionBrokerAuthSource.split(/\r?\n/).length > 110) throw new Error("browser extension broker auth helper exceeded its transport/authentication responsibility");
if (pairingBootstrapSource.split(/\r?\n/).length > 70) throw new Error("browser extension pairing bootstrap helper exceeded its authentication responsibility");
for (const obsolete of ["func: inspectDocument", "func: performAction", "func: performFormFill", "func: performFileUpload"]) {
  if (serviceWorkerSource.includes(obsolete) || browserOperationsSource.includes(obsolete)) throw new Error(`browser service worker retained cross-world helper reference: ${obsolete}`);
}
if (!pageAutomationSource.includes("__machineBridgePageAutomation") || !pageAutomationSource.includes("shadowRoot") || !pageAutomationSource.includes("waitForActionable") || !pageAutomationSource.includes("refFor")) {
  throw new Error("browser page automation module is missing its fixed API or open Shadow DOM traversal");
}
if (!browserOperationsSource.includes("performPageAction") || !browserOperationsSource.includes("safeToFallback")) throw new Error("browser operations lost fixed trusted-input integration or replay protection");
if (!serviceWorkerSource.includes('BROWSER_EXTENSION_PROTOCOL = 3') || !serviceWorkerSource.includes('hello_ack') || !serviceWorkerSource.includes('capabilities:')) throw new Error("browser extension lost its acknowledged versioned capability handshake");
if (!serviceWorkerSource.includes("extension_id: chrome.runtime.id")) throw new Error("browser extension hello no longer binds its runtime identity");
for (const [name, source] of [
  ["src/worker/index.ts", workerSource],
  ["src/worker/websocket-protocol.ts", workerWebSocketProtocolSource],
  ["browser-extension/service-worker.js", serviceWorkerSource],
  ["browser-extension/browser-error-boundary.js", browserErrorBoundarySource],
]) {
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) throw new Error(`${name} contains an unexplained empty catch`);
}
for (const required of [
  "committed", "owner_missing_acknowledged", "stale_connection_rejected",
]) {
  if (!workerObservabilitySource.includes(required)) throw new Error(`Worker terminal-result observability lost disposition: ${required}`);
}
if (!workerSource.includes('from "./daemon-ready-messages.ts"')
    || !workerReadyMessagesSource.includes("pending.resultOwnership(body.id, channel)")
    || !workerReadyMessagesSource.includes('ownership === "missing"')
    || !workerReadyMessagesSource.includes('ownership === "missing" ? "owner_missing_acknowledged" : "stale_connection_rejected"')) {
  throw new Error("Worker result handling no longer separates acknowledged owner-missing late results from rejected stale connections");
}

if (!workerSource.includes('from "./websocket-protocol.ts"')
    || !workerWebSocketProtocolSource.includes("function sendWebSocketQuietly")
    || !workerWebSocketProtocolSource.includes("function closeWebSocketQuietly")) {
  throw new Error("Worker WebSocket best-effort cleanup is not centralized behind the protocol boundary");
}
if (!serviceWorkerSource.includes("function closeSocketQuietly") || !serviceWorkerSource.includes("function sendSocketQuietly") || !serviceWorkerSource.includes("function ignoreBrowserApiCall")) {
  throw new Error("browser extension best-effort cleanup is not centralized");
}
if (!readFileSync(join(root, "src", "local", "browser-bridge.mjs"), "utf8").includes("extension hello required; reload the extension")) throw new Error("browser broker lost stale-extension rejection guidance");
if (!serviceWorkerSource.includes("requires_manual_repair") || !serviceWorkerSource.includes("chrome.action.onClicked")) {
  throw new Error("browser extension no longer requires a user gesture to replace established pairing");
}
if (!serviceWorkerSource.includes("pairingUrlFromEndpoint") || !serviceWorkerSource.includes("setConnectionState") || !serviceWorkerSource.includes("setBadgeText")) {
  throw new Error("browser extension lost action-click pairing access or connection status UX");
}
if (!pageAutomationSource.includes("isSensitiveElement") || !pageAutomationSource.includes("one-time-code")) {
  throw new Error("browser page inspection lost broad sensitive-field redaction");
}

console.log("architecture browser/security structure ok");
