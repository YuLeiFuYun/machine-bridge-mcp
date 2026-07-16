import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// These source-shape checks are supplemental architecture guards. Behavior and failure semantics are tested separately.
const localAutomationFiles = [
  join(root, "src", "local", "app-automation.mjs"),
  join(root, "src", "local", "browser-bridge.mjs"),
  join(root, "src", "local", "browser-operation-service.mjs"),
  join(root, "browser-extension", "service-worker.js"),
  join(root, "browser-extension", "browser-operations.js"),
  join(root, "browser-extension", "devtools-input.js"),
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
if (extensionManifest.manifest_version !== 3 || !extensionManifest.permissions?.includes("scripting") || !extensionManifest.permissions?.includes("alarms") || !extensionManifest.permissions?.includes("debugger")) {
  throw new Error("packaged browser extension is missing required Manifest V3 capabilities");
}
if (!extensionManifest.host_permissions?.includes("<all_urls>")) {
  throw new Error("browser extension no longer declares the generic page access documented by the security model");
}
const serviceWorkerSource = readFileSync(join(root, "browser-extension", "service-worker.js"), "utf8");
const browserOperationsSource = readFileSync(join(root, "browser-extension", "browser-operations.js"), "utf8");
const pageAutomationSource = readFileSync(join(root, "browser-extension", "page-automation.js"), "utf8");
const appAutomationSource = readFileSync(join(root, "src", "local", "app-automation.mjs"), "utf8");
const cliLocalAdminSource = readFileSync(join(root, "src", "local", "cli-local-admin.mjs"), "utf8");
const workerSource = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const workerOAuthControllerSource = readFileSync(join(root, "src", "worker", "oauth-controller.ts"), "utf8");
const workerHttpSource = readFileSync(join(root, "src", "worker", "http.ts"), "utf8");
const oauthBrowserNavigationSource = readFileSync(join(root, "tests", "oauth-browser-navigation-test.mjs"), "utf8");
const workerToolTimeoutSource = readFileSync(join(root, "src", "worker", "tool-timeout.ts"), "utf8");

if (!workerToolTimeoutSource.includes('"browser_manage_tabs", "browser_wait", "browser_get_source"') || !workerToolTimeoutSource.includes('"browser_screenshot", "browser_upload_files"')) {
  throw new Error("Worker timeout classification omits browser_upload_files");
}
for (const origin of ["https://chatgpt.com", "https://chat.openai.com", "https://grok.com", "https://x.com"]) {
  if (!workerHttpSource.includes(`"${origin}"`)) throw new Error(`Worker built-in browser origins omit ${origin}`);
}
if (!workerHttpSource.includes("BUILT_IN_BROWSER_ORIGIN_SET.has(origin)") || !workerHttpSource.includes("allowed.includes(origin)")) {
  throw new Error("Worker CORS validation no longer combines built-in and configured exact origins");
}
if (workerSource.includes("validateOrigin(request") || workerSource.includes('error: "origin_not_allowed"')) {
  throw new Error("Worker actual requests are again being rejected solely by the Origin header");
}
if (!workerSource.includes('request.method === "OPTIONS"') || !workerSource.includes("corsPreflight(request, base, extraOrigins)")) {
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
if (!workerOAuthControllerSource.includes("new URL(authorization.redirectUri).origin")
    || !workerOAuthControllerSource.includes("status, redirectOrigin")) {
  throw new Error("authorization pages no longer bind CSP form navigation to the validated redirect origin");
}
if (!oauthBrowserNavigationSource.includes("negative control reached the first callback")
  || !oauthBrowserNavigationSource.includes("first-hop-only policy unexpectedly followed the regional redirect")
  || !oauthBrowserNavigationSource.includes("regional-only policy unexpectedly followed the final Copilot Studio redirect")
  || !oauthBrowserNavigationSource.includes("authorization callback omitted code")
  || !oauthBrowserNavigationSource.includes("authorization state was not preserved")) {
  throw new Error("real-browser OAuth callback regression lost its first-hop, regional-hop, final-hop, or callback assertions");
}
if (!cliLocalAdminSource.includes("readBoundedRegularFileSync(pairingFile, 64 * 1024)")) {
  throw new Error("browser CLI pairing state read is not bounded");
}
if (!appAutomationSource.includes("matchesList[payload.selector.index]")) {
  throw new Error("application UI selector index is not applied to the filtered match list");
}
if (!appAutomationSource.includes("item.role === 'AXSecureTextField'") || !appAutomationSource.includes("includeValues && !item.sensitive")) {
  throw new Error("application UI inspection does not suppress secure field values");
}
if (!serviceWorkerSource.includes('importScripts("devtools-input.js", "browser-operations.js")')) throw new Error("browser service worker lost fixed browser module loading");
if (!browserOperationsSource.includes('files: ["page-automation.js"]')) {
  throw new Error("browser operations module does not inject the fixed page automation module");
}
if (serviceWorkerSource.split(/\r?\n/).length > 350) throw new Error("browser service worker regained page-operation responsibilities");
for (const obsolete of ["func: inspectDocument", "func: performAction", "func: performFormFill", "func: performFileUpload"]) {
  if (serviceWorkerSource.includes(obsolete) || browserOperationsSource.includes(obsolete)) throw new Error(`browser service worker retained cross-world helper reference: ${obsolete}`);
}
if (!pageAutomationSource.includes("__machineBridgePageAutomation") || !pageAutomationSource.includes("shadowRoot") || !pageAutomationSource.includes("waitForActionable") || !pageAutomationSource.includes("refFor")) {
  throw new Error("browser page automation module is missing its fixed API or open Shadow DOM traversal");
}
if (!browserOperationsSource.includes("performPageAction") || !browserOperationsSource.includes("safeToFallback")) throw new Error("browser operations lost fixed trusted-input integration or replay protection");
if (!serviceWorkerSource.includes('BROWSER_EXTENSION_PROTOCOL = 3') || !serviceWorkerSource.includes('hello_ack') || !serviceWorkerSource.includes('capabilities:')) throw new Error("browser extension lost its acknowledged versioned capability handshake");
for (const [name, source] of [["src/worker/index.ts", workerSource], ["browser-extension/service-worker.js", serviceWorkerSource]]) {
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) throw new Error(`${name} contains an unexplained empty catch`);
}
if (!workerSource.includes("function sendWebSocketQuietly") || !workerSource.includes("function closeWebSocketQuietly")) {
  throw new Error("Worker WebSocket best-effort cleanup is not centralized");
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
