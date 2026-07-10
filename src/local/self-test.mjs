import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSelfTest } from "./daemon.mjs";
import { startLocalApiServer } from "./api-server.mjs";
import { createLogger, redactSecret } from "./log.mjs";
import { acquireDaemonLock, ensureLocalApiKey, ensureWorkerSecrets, loadState, previewSecret, redactState, saveState, selectedWorkspace, setSelectedWorkspace } from "./state.mjs";

await daemonSelfTest();
await stateSelfTest();
await apiSelfTest();
console.log("local daemon/state/api self-test ok");

async function stateSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-test-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-state-workspace-"));
  try {
    setSelectedWorkspace(workspace, stateRoot);
    if (selectedWorkspace(stateRoot) !== workspace) throw new Error("selected workspace was not persisted");
    const state = loadState(workspace, { stateDir: stateRoot });
    ensureWorkerSecrets(state, { rotateSecrets: true });
    ensureLocalApiKey(state, { rotateApiKey: true });
    const lock = acquireDaemonLock(state);
    if (!lock.acquired) throw new Error("first daemon lock acquisition failed");
    try {
      const duplicate = acquireDaemonLock(state);
      if (duplicate.acquired) throw new Error("duplicate daemon lock acquisition should fail");
      if (duplicate.owner?.pid !== process.pid) throw new Error("duplicate daemon lock owner was not reported");
    } finally {
      lock.release();
    }
    const relock = acquireDaemonLock(state);
    if (!relock.acquired) throw new Error("daemon lock was not released");
    relock.release();

    const redacted = redactState(state);
    if (redacted.worker.oauthPassword === state.worker.oauthPassword) throw new Error("oauthPassword was not redacted");
    if (redacted.worker.daemonSecret === state.worker.daemonSecret) throw new Error("daemonSecret was not redacted");
    if (redacted.worker.oauthTokenVersion === state.worker.oauthTokenVersion) throw new Error("oauthTokenVersion was not redacted");
    if (redacted.localApi.apiKey === state.localApi.apiKey) throw new Error("local API key was not redacted");
    if (!previewSecret(state.worker.oauthPassword).includes("...")) throw new Error("previewSecret did not preview long secret");
    if (!redactSecret(state.localApi.apiKey).includes("...")) throw new Error("redactSecret did not preview long secret");

    state.localApi.upstreamUrl = "https://api.example.test/v1";
    state.localApi.upstreamKey = "old-upstream-key";
    state.localApi.upstreamModel = "old-upstream-model";
    saveState(state);
    const migrated = loadState(workspace, { stateDir: stateRoot });
    if ("upstreamUrl" in migrated.localApi || "upstreamKey" in migrated.localApi || "upstreamModel" in migrated.localApi) {
      throw new Error("legacy upstream local API state was not migrated away");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}


async function apiSelfTest() {
  const logger = createLogger({ quiet: true, component: "api-test" });
  const api = await startLocalApiServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-test-key",
    model: "chatgpt-mcp",
    logger,
  });
  const base = `http://${api.host}:${api.port}`;
  try {
    if (api.apiKey !== "local-test-key") throw new Error("local API server did not expose runtime API key for CLI printing");
    const health = await fetch(`${base}/health`);
    if (health.status !== 200) throw new Error(`health returned ${health.status}`);
    const healthPayload = await health.json();
    const expectedHash = createHash("sha256").update("local-test-key").digest("hex");
    if (healthPayload.api_key_sha256 !== expectedHash) throw new Error("health did not expose expected API key hash");
    if (healthPayload.backend !== "chatgpt-mcp") throw new Error("health did not report MCP-backed backend");
    if (healthPayload.mcp_bridge_configured !== false) throw new Error("health should report missing MCP bridge");
    const unauth = await fetch(`${base}/v1/models`);
    if (unauth.status !== 401) throw new Error(`unauthorized models returned ${unauth.status}`);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local-test-key" } });
    if (models.status !== 200) throw new Error(`authorized models returned ${models.status}`);
    const payload = await models.json();
    if (payload?.data?.length !== 1 || payload.data[0].id !== "chatgpt-mcp") throw new Error("model payload should expose local MCP model");
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-mcp", messages: [{ role: "user", content: "hello" }] }),
    });
    if (chat.status !== 503) throw new Error(`missing MCP bridge should return 503, got ${chat.status}`);
    const chatPayload = await chat.json();
    if (!/Remote MCP bridge/.test(chatPayload?.error?.message || "")) throw new Error("missing bridge error did not clarify MCP bridge requirement");

    const unsupported = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    if (unsupported.status !== 501) throw new Error(`unsupported Responses endpoint returned ${unsupported.status}`);
    const unsupportedPayload = await unsupported.json();
    if (unsupportedPayload?.error?.code !== "unsupported_endpoint") throw new Error("unsupported endpoint did not return explicit error code");

  } finally {
    await api.close();
  }

  await mcpSamplingSelfTest(logger);
  await mcpSamplingErrorSelfTest(logger);
}

async function mcpSamplingSelfTest(logger) {
  let captured = null;
  const expectedErrorLogger = { ...logger, error() {} };
  const worker = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      captured = { bridgeToken: req.headers["x-bridge-token"], url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { role: "assistant", content: { type: "text", text: "hello from ChatGPT MCP" }, model: "chatgpt-client-model", stopReason: "endTurn" } }));
    });
  });
  await new Promise(resolve => worker.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const workerPort = worker.address().port;
  const api = await startLocalApiServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-test-key",
    workerUrl: `http://127.0.0.1:${workerPort}`,
    daemonSecret: "daemon-test-secret",
    model: "chatgpt-mcp",
    logger: expectedErrorLogger,
  });
  try {
    const models = await fetch(`http://${api.host}:${api.port}/v1/models`, { headers: { authorization: "Bearer local-test-key" } });
    if (models.status !== 200) throw new Error(`configured models returned ${models.status}`);
    const modelsPayload = await models.json();
    if (modelsPayload?.data?.length !== 1 || modelsPayload.data[0].id !== "chatgpt-mcp") throw new Error("model payload did not expose local MCP model");

    const image = await fetch(`http://${api.host}:${api.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-mcp", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] }] }),
    });
    if (image.status !== 400) throw new Error(`unsupported non-text content returned ${image.status}`);
    const imagePayload = await image.json();
    if (imagePayload?.error?.code !== "unsupported_content") throw new Error("unsupported non-text content did not return explicit error code");

    const response = await fetch(`http://${api.host}:${api.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-hint",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "developer", content: "Use plain text." },
          { role: "user", content: [{ type: "text", text: "Say hello" }] },
        ],
        max_completion_tokens: 77,
      }),
    });
    if (response.status !== 200) throw new Error(`MCP sampling rewrite returned ${response.status}`);
    if (captured?.url !== "/api/mcp/sampling") throw new Error("sampling request did not target Worker sampling endpoint");
    if (captured?.bridgeToken !== "daemon-test-secret") throw new Error("bridge token was not set");
    if (captured?.body?.messages?.[0]?.content?.text !== "Say hello") throw new Error("chat message was not converted to MCP sampling message");
    if (captured?.body?.systemPrompt !== "Be concise.\n\nUse plain text.") throw new Error("system/developer prompt was not forwarded");
    if (captured?.body?.maxTokens !== 77) throw new Error("max_completion_tokens was not converted to maxTokens");
    if (captured?.body?.modelPreferences?.hints?.[0]?.name !== "gpt-5-hint") throw new Error("model hint was not forwarded");
    const payload = await response.json();
    if (payload?.choices?.[0]?.message?.content !== "hello from ChatGPT MCP") throw new Error("MCP sampling result was not wrapped as chat completion");
    if (payload?.model !== "chatgpt-client-model") throw new Error("MCP sampling result model was not preserved");
  } finally {
    await api.close();
    await new Promise(resolve => worker.close(resolve));
  }
}

async function mcpSamplingErrorSelfTest(logger) {
  await withMockWorkerError(
    logger,
    409,
    { error: "mcp_client_stream_missing", message: "No MCP client has an open server-to-client stream for sampling/createMessage." },
    async ({ base }) => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-mcp", messages: [{ role: "user", content: "hello" }] }),
      });
      if (response.status !== 409) throw new Error(`missing MCP stream should return 409, got ${response.status}`);
      const payload = await response.json();
      if (payload?.error?.code !== "mcp_client_stream_missing") throw new Error("missing MCP stream error code was not preserved");
      if (!/MCP client|server-to-client stream/.test(payload?.error?.message || "")) throw new Error("missing MCP stream error message was not explicit");
    }
  );

  await withMockWorkerError(
    logger,
    501,
    { error: "mcp_sampling_not_supported", message: "A connected MCP client did not advertise the MCP sampling capability." },
    async ({ base }) => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-mcp", messages: [{ role: "user", content: "hello" }] }),
      });
      if (response.status !== 501) throw new Error(`missing sampling capability should return 501, got ${response.status}`);
      const payload = await response.json();
      if (payload?.error?.code !== "mcp_sampling_not_supported") throw new Error("missing sampling capability error code was not preserved");
      if (!/sampling capability/.test(payload?.error?.message || "")) throw new Error("missing sampling capability message was not explicit");
    }
  );
}

async function withMockWorkerError(logger, status, payload, callback) {
  const expectedErrorLogger = { ...logger, error() {} };
  const worker = http.createServer((req, res) => {
    req.resume();
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => worker.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const workerPort = worker.address().port;
  const api = await startLocalApiServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-test-key",
    workerUrl: `http://127.0.0.1:${workerPort}`,
    daemonSecret: "daemon-test-secret",
    model: "chatgpt-mcp",
    logger: expectedErrorLogger,
  });
  try {
    await callback({ base: `http://${api.host}:${api.port}` });
  } finally {
    await api.close();
    await new Promise(resolve => worker.close(resolve));
  }
}
