import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createDaemonAuthentication, createDaemonPreflightHeaders, createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../../../src/local/device-identity.mjs";
import { createDaemonHttpRelayHeaders } from "../../../src/local/daemon-http-relay-auth.mjs";
import { accountAdminRequestHeaders } from "../../../src/local/account-admin.mjs";
import { workerToolsForRole } from "../../../src/worker/worker-tool-authority.ts";
import { terminateProcessTreeWithEscalation } from "../../../src/local/process-tree.mjs";
import serverMetadata from "../../../src/shared/server-metadata.json" with { type: "json" };
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../../../src/worker/mcp-subscription-contract.ts";


export const integrationContext = {
  base: "",
  pkg: { version: "3.0.0" },
  DAEMON_SESSION_IDENTITY: null,
  activeHttpRequests: new Set(),
};

export function configureWorkerIntegration(ctx) {
  Object.assign(integrationContext, ctx);
}

export let daemonInstanceSequence = 0;
export const WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS = 10_000;

async function registerTestClient({ base, redirectUri, name }) {
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  });
  assert(registration.response.status === 201, `test client registration failed: ${registration.response.status}`);
  return registration.body;
}

async function issueAccountToken({ base, clientId, redirectUri, accountName, password, state }) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "machine-bridge-mcp",
    resource: `${base}/mcp`,
    state,
    account_name: accountName,
    account_password: password,
  };
  const approved = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(authorization),
    redirect: "manual",
  });
  assert(approved.status === 303, `account authorization failed: ${approved.status}`);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  assert(code, "account authorization omitted code");
  const token = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(token.response.status === 200, `account token exchange failed: ${token.response.status}`);
  assert(typeof token.body.access_token === "string", "account token exchange omitted access_token");
  assert(typeof token.body.refresh_token === "string", "account token exchange omitted refresh_token");
  return { accessToken: token.body.access_token, refreshToken: token.body.refresh_token };
}

async function connectDaemon(origin, headers = createDaemonPreflightHeaders(
  integrationContext.DAEMON_SESSION_IDENTITY,
  origin,
  "machine-bridge-mcp",
  integrationContext.pkg?.version,
)) {
  const wsUrl = `${origin.replace(/^http/, "ws")}/daemon/ws`;
  const socket = new WebSocket(wsUrl, { headers });
  const welcome = waitForWsMessage(socket, "welcome");
  await withTimeout(new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  }), 5000, "daemon websocket open");
  socket.mbmWelcome = await welcome;
  return socket;
}


async function rejectedDaemonUpgradeStatus(origin, headers) {
  const wsUrl = `${origin.replace(/^http/, "ws")}/daemon/ws`;
  return withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers });
    let settled = false;
    socket.once("unexpected-response", (_request, response) => {
      settled = true;
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      socket.close();
      if (!settled) reject(new Error("replayed daemon preflight unexpectedly upgraded"));
    });
    socket.once("error", (error) => {
      if (!settled) reject(error);
    });
  }), 5000, "replayed daemon preflight rejection");
}

async function sendDaemonHello(socket, tools, policy = defaultDaemonPolicy(), instanceId = nextDaemonInstanceId()) {
  const probe = await beginDaemonHello(socket, tools, policy, instanceId);
  return completeDaemonProbe(socket, probe);
}

async function beginDaemonHello(socket, tools, policy = defaultDaemonPolicy(), instanceId = nextDaemonInstanceId()) {
  const handshake = waitForWsMessageSequence(socket, ["hello_ack", "relay_probe"]);
  const authentication = await createDaemonAuthentication(integrationContext.DAEMON_SESSION_IDENTITY, socket.mbmWelcome, instanceId);
  socket.send(JSON.stringify({
    type: "hello",
    instance_id: instanceId,
    tools,
    policy,
    protocol_versions: ["2026-07-28"],
    authentication,
  }));
  const [, probe] = await handshake;
  assert(typeof probe.id === "string" && probe.id.startsWith("probe_"), "Worker readiness probe omitted a valid id");
  return probe;
}

async function completeDaemonProbe(socket, probe) {
  const ready = waitForWsMessageSequence(socket, ["resume_calls", "ready_ack"]);
  socket.send(JSON.stringify({ type: "relay_probe_result", id: probe.id }));
  const [resume] = await ready;
  assert(Array.isArray(resume.ids), "Worker resume_calls omitted its call-id array");
  return resume;
}

async function completeDaemonProbeWithRevocations(socket, probe, count) {
  const ready = waitForWsMessageSequence(socket, ["resume_calls", ...Array(count).fill("authority_revoke"), "ready_ack"]);
  socket.send(JSON.stringify({ type: "relay_probe_result", id: probe.id }));
  const messages = await ready;
  const resume = messages[0];
  assert(Array.isArray(resume.ids), "Worker revocation replay omitted resume_calls or its call-id array");
  return { resume, revocations: messages.slice(1, -1) };
}

function nextDaemonInstanceId() {
  daemonInstanceSequence += 1;
  return `daemon_integration_${String(daemonInstanceSequence).padStart(6, "0")}`;
}

function defaultDaemonPolicy() {
  return { profile: "review", allowWrite: false, allowExec: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
}

function waitForWsMessageSequence(socket, expectedTypes, timeoutMs = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (data) => {
      try {
        const value = JSON.parse(String(data));
        const expected = expectedTypes[messages.length];
        if (value.type !== expected) throw new Error(`expected websocket message ${expected}, received ${value.type}`);
        messages.push(value);
        if (messages.length === expectedTypes.length) {
          cleanup();
          resolve(messages);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = (code) => { cleanup(); reject(new Error(`websocket closed before ${expectedTypes.join(", ")}: ${code}`)); };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  }), timeoutMs, `websocket message sequence ${expectedTypes.join(", ")}`);
}


function captureWsMessageTypes(socket) {
  const types = [];
  let parseError = null;
  const onMessage = (data) => {
    try { types.push(JSON.parse(String(data)).type); }
    catch (error) { parseError = error; }
  };
  socket.on("message", onMessage);
  return {
    stop() {
      socket.off("message", onMessage);
      if (parseError) throw parseError;
      return types;
    },
  };
}

function waitForWsMessage(socket, expectedType, timeoutMs = WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS, label = expectedType) {
  const callSite = new Error().stack?.split("\n")[2]?.trim() || "unknown call site";
  const interleavedTypes = expectedType === "tool_call" || expectedType === "cancel_call"
    ? new Set(["tool_result_ack"])
    : new Set();
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (data) => {
      try {
        const value = JSON.parse(String(data));
        if (value.type === expectedType) {
          cleanup();
          resolve(value);
          return;
        }
        if (interleavedTypes.has(value.type)) return;
        cleanup();
        reject(new Error(`expected websocket message ${expectedType}, received ${value.type}`));
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = (code) => { cleanup(); reject(new Error(`websocket closed before ${expectedType}: ${code}`)); };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  }), timeoutMs, `websocket message ${label} requested at ${callSite}`);
}

function waitForWsClose(socket, timeoutMs = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
    socket.once("error", reject);
  }), timeoutMs, "daemon close");
}

function currentMcpHeaders(accessToken, method, name = "", version = "2026-07-28") {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": encodeMcpHeaderValue(name) } : {}),
  };
}

function currentMcpRequest(id, method, params, version = "2026-07-28", clientCapabilities = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
        "io.modelcontextprotocol/clientInfo": { name: "worker-current-integration", version: "1" },
      },
    },
  };
}

async function currentMcpCall(origin, accessToken, id, method, params, clientCapabilities = {}) {
  const name = method === "tools/call" ? String(params.name || "") : "";
  const response = await stableFetch(`${origin}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(accessToken, method, name),
    body: JSON.stringify(currentMcpRequest(id, method, params, "2026-07-28", clientCapabilities)),
  });
  const text = await response.text();
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    return { response, body: messages.at(-1) ?? {}, text };
  }
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body, text };
}

function encodeMcpHeaderValue(value) {
  const text = String(value);
  const plain = text === text.trim() && /^[\x20-\x7e]*$/.test(text) && !(text.startsWith("=?base64?") && text.endsWith("?="));
  return plain ? text : `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function toolCallRequest(origin, accessToken, id, name, argumentsValue) {
  return currentMcpCall(origin, accessToken, id, "tools/call", { name, arguments: argumentsValue });
}

async function daemonHttpExchange(body) {
  const serialized = JSON.stringify(body);
  const headers = createDaemonHttpRelayHeaders(
    integrationContext.DAEMON_SESSION_IDENTITY, integrationContext.base, "machine-bridge-mcp", integrationContext.pkg?.version, serialized,
  );
  const response = await trackHttpRequest(fetch(`${integrationContext.base}/daemon/http`, {
    method: "POST", headers, body: serialized, signal: AbortSignal.timeout(10_000),
  }));
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`daemon HTTP exchange returned non-JSON status=${response.status}: ${text.slice(0, 256)}`); }
  return { response, body: parsed };
}

async function callTool(origin, accessToken, id, name, argumentsValue) {
  const response = await toolCallRequest(origin, accessToken, id, name, argumentsValue);
  assert(response.response.status === 200, `${name} call failed: ${response.response.status}`);
  return response.body;
}

async function callServerInfo(origin, accessToken, id, args = {}) {
  const response = await currentMcpCall(origin, accessToken, id, "tools/call", { name: "server_info", arguments: args });
  assert(response.response.status === 200, `server_info call failed: ${response.response.status}`);
  const text = response.body.result?.content?.[0]?.text;
  const structured = response.body.result?.structuredContent;
  assert(typeof text === "string", "server_info result did not contain text");
  assert(structured && typeof structured === "object", "server_info result omitted structuredContent");
  assert(JSON.stringify(structured) === JSON.stringify(JSON.parse(text)), "server_info text and structuredContent diverged");
  return structured;
}

async function callToolsList(origin, accessToken, id) {
  const response = await currentMcpCall(origin, accessToken, id, "tools/list", {});
  assert(response.response.status === 200, `tools/list failed: ${response.response.status}`);
  assert(Array.isArray(response.body.result?.tools), "tools/list did not return an array");
  return response.body.result.tools;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForWorker(origin, processHandle, closedPromise) {
  let consecutiveHealthy = 0;
  let latestBody = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      const result = await closedPromise;
      throw new Error(`wrangler exited before readiness: ${JSON.stringify(result)}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        latestBody = await response.json();
        consecutiveHealthy += 1;
        if (consecutiveHealthy >= 3) {
          await sleep(200);
          return latestBody;
        }
      } else {
        consecutiveHealthy = 0;
      }
    } catch {
      consecutiveHealthy = 0;
    }
    await sleep(150);
  }
  throw new Error(`wrangler dev did not become stably ready within 30s (exitCode=${processHandle.exitCode}, signalCode=${processHandle.signalCode})`);
}


function adminRequest(method, pathname, body) {
  const serializedBody = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    headers: {
      ...accountAdminRequestHeaders({
        sessionIdentity: integrationContext.DAEMON_SESSION_IDENTITY,
        origin: new URL(integrationContext.base).origin,
        method,
        pathname,
        body: serializedBody,
      }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : serializedBody,
  };
}

function stableFetch(url, options = {}, attempts = 3) {
  return trackHttpRequest(stableFetchAttempt(url, options, attempts));
}

async function stableFetchAttempt(url, options = {}, attempts = 3) {
  let lastResponse;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      if (response.status !== 503 || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await sleep(100 * attempt);
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error("fetch failed without a response");
}

async function readSseJsonRpcResponse(reader, initialText = "") {
  const decoder = new TextDecoder();
  let text = initialText;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return parseSseJsonRpcResponse(text);
}

function parseSseJsonRpcResponse(text) {
  const eventIds = text.split(/\r?\n/)
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice(4));
  const messages = parseSseJsonMessages(text);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && typeof messages[index] === "object") return { message: messages[index], eventIds, text };
  }
  throw new Error(`SSE response omitted a JSON-RPC message: ${text.slice(0, 512)}`);
}

function parseSseJsonMessages(text) {
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try { messages.push(JSON.parse(line.slice(6))); } catch {}
  }
  return messages;
}

async function readSseJsonMessages(reader, count) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const messages = parseSseJsonMessages(text);
    if (messages.length >= count) return messages.slice(0, count);
    const chunk = await reader.read();
    if (chunk.done) return messages;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function fetchJson(url, options) {
  return trackHttpRequest(fetchJsonResponse(url, options));
}

async function fetchJsonResponse(url, options) {
  const response = await stableFetchAttempt(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body };
}

function trackHttpRequest(promise) {
  const request = Promise.resolve(promise);
  integrationContext.activeHttpRequests.add(request);
  const release = () => { integrationContext.activeHttpRequests.delete(request); };
  request.then(release, release);
  return request;
}

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EPERM" || error?.code === "EACCES") resolve(0);
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portValue = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(portValue));
    });
  });
}

async function terminate(processHandle) {
  if (!processHandle?.pid) return;
  await new Promise((resolve) => {
    terminateProcessTreeWithEscalation(processHandle, {
      graceMs: 3000,
      onTerminationSettled: resolve,
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function cspDirectiveSources(policy, directiveName) {
  for (const directive of String(policy || "").split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === directiveName) return new Set(tokens.slice(1));
  }
  return new Set();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}


export {
  spawn, createHash, randomBytes, mkdtemp, readFile, rm, net, os, path, fileURLToPath,
  WebSocket, createDaemonAuthentication, createDaemonPreflightHeaders, createDeviceIdentity,
  createDeviceSessionIdentity, publicDeviceJwkJson, createDaemonHttpRelayHeaders,
  accountAdminRequestHeaders, workerToolsForRole, terminateProcessTreeWithEscalation,
  serverMetadata, MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS,
  registerTestClient, issueAccountToken, connectDaemon, rejectedDaemonUpgradeStatus,
  sendDaemonHello, beginDaemonHello, completeDaemonProbe, completeDaemonProbeWithRevocations,
  nextDaemonInstanceId, defaultDaemonPolicy, waitForWsMessageSequence, captureWsMessageTypes,
  waitForWsMessage, waitForWsClose, currentMcpHeaders, currentMcpRequest, currentMcpCall,
  encodeMcpHeaderValue, toolCallRequest, daemonHttpExchange, callTool, callServerInfo,
  callToolsList, withTimeout, waitForWorker, adminRequest, stableFetch, stableFetchAttempt,
  readSseJsonRpcResponse, parseSseJsonRpcResponse, parseSseJsonMessages, readSseJsonMessages,
  fetchJson, fetchJsonResponse, trackHttpRequest, openPort, terminate, appendBounded,
  cspDirectiveSources, assert, sleep
};
