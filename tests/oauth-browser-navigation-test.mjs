import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const chrome = findChrome();
if (!chrome) {
  if (process.env.CI && process.platform === "linux") throw new Error("Chrome is required for the OAuth browser navigation regression on Linux CI");
  console.log("OAuth browser navigation test skipped: Chrome not found");
  process.exit(0);
}

const callbackServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><title>OAuth callback reached</title><p id=done>done</p>");
});
const callbackPort = await listen(callbackServer);
const callbackOrigin = `http://127.0.0.1:${callbackPort}`;

const authorizationServer = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (request.method === "POST" && requestUrl.pathname === "/oauth/authorize") {
    response.writeHead(303, { location: `${callbackOrigin}/callback?code=test-code&state=test-state`, "cache-control": "no-store" });
    response.end();
    return;
  }
  const callbackSource = requestUrl.searchParams.get("allow") === "1" ? ` ${callbackOrigin}` : "";
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackSource}; base-uri 'none'; frame-ancestors 'none'`,
  });
  response.end(`<!doctype html><title>Authorize</title><form method="post" action="/oauth/authorize"><button id="authorize" type="submit">Authorize</button></form>`);
});
const authorizationPort = await listen(authorizationServer);
const authorizationOrigin = `http://127.0.0.1:${authorizationPort}`;
const blockedAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=0`;
const allowedAuthorizationUrl = `${authorizationOrigin}/oauth/authorize?allow=1`;

const profile = await mkdtemp(path.join(os.tmpdir(), "mbm-oauth-browser-"));
const debuggingPort = await openPort();
const child = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`,
  blockedAuthorizationUrl,
], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let chromeStderr = "";
child.stderr.on("data", (chunk) => { chromeStderr = `${chromeStderr}${chunk}`.slice(-16_384); });
const childClosed = new Promise((resolve) => child.once("close", resolve));

try {
  const target = await waitForPageTarget(debuggingPort);
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await sleep(500);
    const blockedResult = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    const blockedUrl = String(blockedResult.result?.result?.value ?? "");
    assert(!blockedUrl.startsWith(callbackOrigin), "negative control unexpectedly reached the callback under form-action 'self'");

    await client.send("Page.navigate", { url: allowedAuthorizationUrl });
    await waitForExpression(client, "document.readyState === 'complete' && Boolean(document.getElementById('authorize'))");
    await client.send("Runtime.evaluate", { expression: "document.getElementById('authorize').click()" });
    await waitForExpression(client, `location.origin === ${JSON.stringify(callbackOrigin)} && location.pathname === '/callback'`);
    const result = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    const finalUrl = String(result.result?.result?.value ?? "");
    const parsed = new URL(finalUrl);
    assert(parsed.origin === callbackOrigin, `authorization did not reach the callback origin: ${finalUrl}`);
    assert(parsed.searchParams.get("code") === "test-code", "authorization callback omitted code");
    assert(parsed.searchParams.get("state") === "test-state", "authorization callback omitted state");
  } finally {
    client.close();
  }
  console.log("OAuth browser navigation test ok");
} catch (error) {
  throw new Error(`${error.message}\nChrome stderr:\n${chromeStderr}`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([childClosed, sleep(5000)]);
  authorizationServer.close();
  callbackServer.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(100);
    }
  }
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

async function waitForPageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === "page");
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {}
    await sleep(50);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function createCdpClient(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(message); }
