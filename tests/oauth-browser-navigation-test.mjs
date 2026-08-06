import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const BROWSER_STARTUP_TIMEOUT_MS = 60_000;
const HTTP_PROBE_TIMEOUT_MS = 1_000;
const CDP_OPEN_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const BROWSER_TERMINATION_GRACE_MS = 5_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

const chrome = findChrome();
if (!chrome) {
  if (process.env.CI && process.platform === "linux") throw new Error("Chrome is required for the OAuth browser navigation regression on Linux CI");
  console.log("OAuth browser navigation test skipped: Chrome not found");
  process.exit(0);
}

let studioCallbackHits = 0;
const studioCallbackServer = http.createServer((_request, response) => {
  studioCallbackHits += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><title>OAuth callback reached</title><p id=done>done</p>");
});
const studioCallbackPort = await listen(studioCallbackServer);
const studioCallbackOrigin = `http://127.0.0.1:${studioCallbackPort}`;

let regionalCallbackHits = 0;
const regionalCallbackServer = http.createServer((request, response) => {
  regionalCallbackHits += 1;
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  response.writeHead(302, {
    location: `${studioCallbackOrigin}/connection/oauth/redirect${requestUrl.search}`,
    "cache-control": "no-store",
  });
  response.end();
});
const regionalCallbackPort = await listen(regionalCallbackServer);
const regionalCallbackOrigin = `http://127.0.0.1:${regionalCallbackPort}`;

let globalCallbackHits = 0;
const globalCallbackServer = http.createServer((request, response) => {
  globalCallbackHits += 1;
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  response.writeHead(302, {
    location: `${regionalCallbackOrigin}/redirect${requestUrl.search}`,
    "cache-control": "no-store",
  });
  response.end();
});
const globalCallbackPort = await listen(globalCallbackServer);
const globalCallbackOrigin = `http://127.0.0.1:${globalCallbackPort}`;

const authorizationServer = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (request.method === "POST" && requestUrl.pathname === "/oauth/authorize") {
    response.writeHead(303, { location: `${globalCallbackOrigin}/redirect?code=test-code&state=test-state`, "cache-control": "no-store" });
    response.end();
    return;
  }
  const allow = Number(requestUrl.searchParams.get("allow") ?? "0");
  const formActionSources = ["'self'"];
  if (allow >= 1) formActionSources.push(globalCallbackOrigin);
  if (allow >= 2) formActionSources.push(regionalCallbackOrigin);
  if (allow >= 3) formActionSources.push(studioCallbackOrigin);
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources.join(" ")}; base-uri 'none'; frame-ancestors 'none'`,
  });
  response.end(`<!doctype html><title>Authorize</title><form method="post" action="/oauth/authorize"><button id="authorize" type="submit">Authorize</button></form>`);
});
const authorizationPort = await listen(authorizationServer);
const authorizationOrigin = `http://127.0.0.1:${authorizationPort}`;
const blockedAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=0`;
const firstHopOnlyAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=1`;
const regionalOnlyAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=2`;
const allowedAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=3`;

const profile = await mkdtemp(path.join(os.tmpdir(), "mbm-oauth-browser-"));
const debuggingPort = await openPort();
const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`,
];
if (process.platform === "linux") chromeArgs.push("--no-sandbox", "--disable-dev-shm-usage");
chromeArgs.push(blockedAuthorizationUrl);
const child = spawn(chrome, chromeArgs, {
  stdio: ["ignore", "ignore", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
let chromeStderr = "";
let childOutcome = null;
child.stderr.on("data", (chunk) => { chromeStderr = `${chromeStderr}${chunk}`.slice(-16_384); });
const childClosed = new Promise((resolve) => {
  child.once("error", (error) => {
    childOutcome = { error };
    resolve(childOutcome);
  });
  child.once("close", (code, signal) => {
    childOutcome = { code, signal };
    resolve(childOutcome);
  });
});

let primaryError = null;
try {
  const target = await waitForPageTarget(debuggingPort, () => childOutcome);
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await sleep(500);
    assert(globalCallbackHits === 0, "negative control reached the first callback under form-action 'self'");
    assert(regionalCallbackHits === 0, "negative control unexpectedly reached the regional callback");
    assert(studioCallbackHits === 0, "negative control unexpectedly reached the studio callback");

    await client.send("Page.navigate", { url: firstHopOnlyAuthorizationUrl });
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await sleep(500);
    assert(globalCallbackHits === 1, "first-hop policy did not reach the registered callback origin");
    assert(regionalCallbackHits === 0, "first-hop-only policy unexpectedly followed the regional redirect");
    assert(studioCallbackHits === 0, "first-hop-only policy unexpectedly reached the studio callback");

    await client.send("Page.navigate", { url: regionalOnlyAuthorizationUrl });
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await sleep(500);
    assert(globalCallbackHits === 2, "regional policy did not reach the registered callback origin");
    assert(regionalCallbackHits === 1, "regional policy did not follow the consent subdomain redirect");
    assert(studioCallbackHits === 0, "regional-only policy unexpectedly followed the final Copilot Studio redirect");

    await client.send("Page.navigate", { url: allowedAuthorizationUrl });
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await waitForExpression(client, `location.origin === ${JSON.stringify(studioCallbackOrigin)} && location.pathname === '/connection/oauth/redirect'`);
    const result = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    const finalUrl = String(result.result?.result?.value ?? "");
    const parsed = new URL(finalUrl);
    assert(parsed.origin === studioCallbackOrigin, `authorization did not reach the Copilot Studio callback origin: ${finalUrl}`);
    assert(parsed.searchParams.get("code") === "test-code", "authorization callback omitted code");
    assert(parsed.searchParams.get("state") === "test-state", "authorization state was not preserved");
  } finally {
    client.close();
  }
} catch (error) {
  primaryError = new Error(`${error.message}
Chrome stderr:
${chromeStderr}`, { cause: error });
}

const cleanupErrors = [];
try { await terminateBrowserTree(child, childClosed, () => childOutcome); }
catch (error) { cleanupErrors.push(error); }
for (const server of [authorizationServer, globalCallbackServer, regionalCallbackServer, studioCallbackServer]) {
  try { await closeHttpServer(server); }
  catch (error) { cleanupErrors.push(error); }
}
try { await removeBrowserProfile(profile); }
catch (error) { cleanupErrors.push(error); }

if (primaryError && cleanupErrors.length) {
  throw new AggregateError([primaryError, ...cleanupErrors], "OAuth browser navigation failed and browser cleanup was incomplete");
}
if (primaryError) throw primaryError;
if (cleanupErrors.length === 1) throw cleanupErrors[0];
if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "OAuth browser cleanup was incomplete");
console.log("OAuth browser navigation test ok");

async function terminateBrowserTree(browser, closed, outcome) {
  if (outcome()) return;
  signalBrowserTree(browser, "SIGTERM");
  if (await waitForBrowserClose(closed, outcome, BROWSER_TERMINATION_GRACE_MS)) return;
  signalBrowserTree(browser, "SIGKILL");
  if (await waitForBrowserClose(closed, outcome, BROWSER_TERMINATION_GRACE_MS)) return;
  throw new Error(`Chrome process tree did not exit within ${BROWSER_TERMINATION_GRACE_MS * 2} ms`);
}

function signalBrowserTree(browser, signal) {
  if (!browser.pid || browser.exitCode !== null || browser.signalCode !== null) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const result = spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: BROWSER_TERMINATION_GRACE_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      if (result.error && result.error.code !== "ENOENT") throw result.error;
      return;
    }
    browser.kill("SIGTERM");
    return;
  }
  try { process.kill(-browser.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function waitForBrowserClose(closed, outcome, timeoutMs) {
  if (outcome()) return true;
  await Promise.race([closed, sleep(timeoutMs)]);
  return Boolean(outcome());
}

function closeHttpServer(server) {
  server.closeAllConnections?.();
  return Promise.race([
    new Promise((resolve, reject) => {
      server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    }),
    sleep(SERVER_CLOSE_TIMEOUT_MS).then(() => { throw new Error(`HTTP test server did not close within ${SERVER_CLOSE_TIMEOUT_MS} ms`); }),
  ]);
}

async function removeBrowserProfile(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(100);
    }
  }
  throw lastError || new Error("browser profile cleanup failed");
}

function findChrome() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function openPort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPageTarget(port, childOutcome) {
  const deadline = Date.now() + BROWSER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const outcome = childOutcome();
    if (outcome) {
      const detail = outcome.error?.message || `exit=${outcome.code ?? "unknown"}; signal=${outcome.signal ?? "none"}`;
      throw new Error(`Chrome exited before DevTools became ready: ${detail}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === "page");
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {}
    await sleep(50);
  }
  throw new Error(`Chrome DevTools endpoint did not become ready within ${BROWSER_STARTUP_TIMEOUT_MS} ms`);
}

async function createCdpClient(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`Chrome DevTools WebSocket did not open within ${CDP_OPEN_TIMEOUT_MS} ms`));
    }, CDP_OPEN_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    socket.once("open", opened);
    socket.once("error", failed);
  });
  let nextId = 1;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message);
  });
  socket.on("close", () => rejectPending(new Error("Chrome DevTools WebSocket closed")));
  socket.on("error", (error) => rejectPending(error));
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS} ms`));
        }, CDP_COMMAND_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() { socket.close(); },
  };
}

async function waitForExpression(client, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.send("Runtime.evaluate", { expression, returnByValue: true });
    if (response.result?.result?.value === true) return;
    await sleep(50);
  }
  const location = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
  throw new Error(`browser condition timed out at ${location.result?.result?.value ?? "unknown URL"}`);
}

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }
function assert(value, message) { if (!value) throw new Error(message); }
