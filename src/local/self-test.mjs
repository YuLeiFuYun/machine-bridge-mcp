import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSelfTest } from "./daemon.mjs";
import { normalizeBaseUrl, startLocalApiServer } from "./api-server.mjs";
import { createLogger, redactSecret } from "./log.mjs";
import { acquireDaemonLock, ensureLocalApiKey, ensureWorkerSecrets, loadState, previewSecret, redactState, selectedWorkspace, setSelectedWorkspace } from "./state.mjs";

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
    state.localApi.upstreamKey = "upstream_key_test_redaction_value";
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
    if (redacted.localApi.upstreamKey === state.localApi.upstreamKey) throw new Error("upstream API key was not redacted");
    if (!previewSecret(state.worker.oauthPassword).includes("...")) throw new Error("previewSecret did not preview long secret");
    if (!redactSecret(state.localApi.apiKey).includes("...")) throw new Error("redactSecret did not preview long secret");
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}


async function apiSelfTest() {
  try {
    normalizeBaseUrl("https://user:pass@example.com/v1");
    throw new Error("upstream URL credentials were accepted");
  } catch (error) {
    if (!/must not contain credentials/.test(error.message)) throw error;
  }
  try {
    normalizeBaseUrl("https://example.com/v1?api_key=secret");
    throw new Error("upstream URL query string was accepted");
  } catch (error) {
    if (!/without query strings/.test(error.message)) throw error;
  }

  const logger = createLogger({ quiet: true, component: "api-test" });
  const api = await startLocalApiServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-test-key",
    upstreamKey: "",
    model: "ignored-local-model-option",
    upstreamModel: "test-model",
    logger,
  });
  const base = `http://${api.host}:${api.port}`;
  try {
    const health = await fetch(`${base}/health`);
    if (health.status !== 200) throw new Error(`health returned ${health.status}`);
    const healthPayload = await health.json();
    const expectedHash = createHash("sha256").update("local-test-key").digest("hex");
    if (healthPayload.api_key_sha256 !== expectedHash) throw new Error("health did not expose expected API key hash");
    if (healthPayload.upstream_configured !== false) throw new Error("health should report no external model provider");
    if (healthPayload.chatgpt_web_backed !== false) throw new Error("local API must not claim ChatGPT web backing");
    const unauth = await fetch(`${base}/v1/models`);
    if (unauth.status !== 401) throw new Error(`unauthorized models returned ${unauth.status}`);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local-test-key" } });
    if (models.status !== 200) throw new Error(`authorized models returned ${models.status}`);
    const payload = await models.json();
    if (payload?.data?.length !== 0) throw new Error("unconfigured model payload should be empty");
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    if (chat.status !== 503) throw new Error(`missing external provider should return 503, got ${chat.status}`);
    const chatPayload = await chat.json();
    if (!/not backed by ChatGPT web/.test(chatPayload?.error?.message || "")) throw new Error("missing provider error did not clarify ChatGPT web backing");
  } finally {
    await api.close();
  }

  await proxyModelSelfTest(logger);
}

async function proxyModelSelfTest(logger) {
  let captured = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      captured = { authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "ok", choices: [] }));
    });
  });
  await new Promise(resolve => upstream.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const upstreamPort = upstream.address().port;
  const api = await startLocalApiServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-test-key",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    upstreamKey: "upstream-test-key",
    model: "ignored-local-model-option",
    upstreamModel: "real-upstream-model",
    logger,
  });
  try {
    const models = await fetch(`http://${api.host}:${api.port}/v1/models`, { headers: { authorization: "Bearer local-test-key" } });
    if (models.status !== 200) throw new Error(`configured models returned ${models.status}`);
    const modelsPayload = await models.json();
    if (modelsPayload?.data?.length !== 1 || modelsPayload.data[0].id !== "real-upstream-model") throw new Error("configured model payload did not expose upstream model");

    const response = await fetch(`http://${api.host}:${api.port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "real-upstream-model", messages: [] }),
    });
    if (response.status !== 200) throw new Error(`proxy rewrite returned ${response.status}`);
    if (captured?.authorization !== "Bearer upstream-test-key") throw new Error("upstream authorization was not set");
    if (captured?.body?.model !== "real-upstream-model") throw new Error("upstream model was not preserved");
  } finally {
    await api.close();
    await new Promise(resolve => upstream.close(resolve));
  }
}
