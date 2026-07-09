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
    model: "test-model",
    logger,
  });
  const base = `http://${api.host}:${api.port}`;
  try {
    const health = await fetch(`${base}/health`);
    if (health.status !== 200) throw new Error(`health returned ${health.status}`);
    const unauth = await fetch(`${base}/v1/models`);
    if (unauth.status !== 401) throw new Error(`unauthorized models returned ${unauth.status}`);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local-test-key" } });
    if (models.status !== 200) throw new Error(`authorized models returned ${models.status}`);
    const payload = await models.json();
    if (payload?.data?.[0]?.id !== "test-model") throw new Error("model payload did not include configured model");
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    if (chat.status !== 503) throw new Error(`missing upstream key should return 503, got ${chat.status}`);
  } finally {
    await api.close();
  }
}
