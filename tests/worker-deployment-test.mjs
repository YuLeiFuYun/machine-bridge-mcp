import assert from "node:assert/strict";
import http from "node:http";
import { createDeviceIdentity } from "../src/local/device-identity.mjs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureWorkerDeployment,
  extractWorkerUrl,
  workerDeploymentFingerprint,
  workerUrlMatchesName,
} from "../src/local/worker-deployment.mjs";
import {
  requestWorkerHealthJson,
  retryWorkerHealth,
  workerHealth,
  workerHealthError,
  normalizeWorkerOrigin,
  workerHealthRequiresRedeploy,
  workerHealthUrl,
  workerHealthUserReason,
} from "../src/local/worker-health.mjs";
import { proxyAgentForHttp, proxyAgentForWebSocket } from "../src/local/network-proxy.mjs";
import { ensureWorkerSecrets, loadState, saveState } from "../src/local/state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "9.8.7";
const target = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, server: "machine-bridge-mcp", version }));
    return;
  }
  if (request.url === "/redirect/healthz") {
    response.writeHead(302, { Location: "/healthz" }).end();
    return;
  }
  if (request.url === "/invalid/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" }).end("not-json");
    return;
  }
  if (request.url === "/wrong/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, server: "other-server", version }));
    return;
  }
  if (request.url === "/large/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(`{"padding":"${"x".repeat(70 * 1024)}"}`);
    return;
  }
  if (request.url === "/slow/healthz") return;
  if (request.url === "/unavailable/healthz") {
    response.writeHead(503).end("unavailable");
    return;
  }
  response.writeHead(404).end();
});
await listen(target);

const proxy = http.createServer();
let proxyConnects = 0;
proxy.on("connect", (_request, clientSocket, head) => {
  proxyConnects += 1;
  const upstream = net.connect(address(target).port, "127.0.0.1", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
});
await listen(proxy);

try {
  verifyWorkerFingerprintPathBoundaries();
  const workerUrl = "https://worker-health.account-example.workers.dev";
  const expectedWorkerName = "worker-health";
  assert.equal(normalizeWorkerOrigin(workerUrl, expectedWorkerName), workerUrl);
  assert.equal(workerHealthUrl(workerUrl, expectedWorkerName), `${workerUrl}/healthz`);
  for (const invalid of [
    "http://worker-health.account-example.workers.dev",
    "https://worker-health.example.invalid",
    "https://worker-health.extra.account-example.workers.dev",
    ["https://", "test-user", ":", "test-pass", "@", "worker-health.account-example.workers.dev"].join(""),
    "https://worker-health.account-example.workers.dev/path",
    "https://worker-health.account-example.workers.dev?query=1",
  ]) {
    assert.throws(() => workerHealthUrl(invalid, expectedWorkerName));
  }
  assert.throws(() => workerHealthUrl(workerUrl, "other-worker"), /does not match/);
  assert.equal((await workerHealth("not a URL", version)).error, "invalid_worker_url");
  assert.equal((await workerHealth("ftp://worker-health.account-example.workers.dev", version)).error, "invalid_worker_url");

  const direct = await requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/healthz`, { proxyResolver: () => "" });
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.body.version, version);
  assert.equal(direct.networkRoute, "direct");

  const redirected = await requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/redirect/healthz`, { proxyResolver: () => "" });
  assert.equal(redirected.statusCode, 302, "health transport followed an untrusted redirect");
  const invalidBody = await requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/invalid/healthz`, { proxyResolver: () => "" });
  assert.equal(invalidBody.body, null);

  const healthy = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    probe: async () => direct,
  });
  assert.deepEqual(healthy, { ok: true, version, networkRoute: "direct" });
  const wrongIdentity = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    probe: async () => ({ statusCode: 200, body: { ok: true, server: "other-server", version }, networkRoute: "direct" }),
  });
  assert.equal(wrongIdentity.error, "unexpected_health_response");
  const versionMismatch = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    probe: async () => ({ statusCode: 200, body: { ok: true, server: "machine-bridge-mcp", version: "1.0.0" }, networkRoute: "direct" }),
  });
  assert.equal(versionMismatch.error, "version_mismatch:1.0.0!=9.8.7");
  for (const hostileVersion of ["x".repeat(1024), "1.0.0\nprivate-detail", "/Users/private/version", ""]) {
    const invalidVersion = await workerHealth(workerUrl, version, {
      expectedWorkerName,
      probe: async () => ({ statusCode: 200, body: { ok: true, server: "machine-bridge-mcp", version: hostileVersion }, networkRoute: "direct" }),
    });
    assert.equal(invalidVersion.error, "unexpected_health_response");
    assert(!JSON.stringify(invalidVersion).includes("private-detail") && !JSON.stringify(invalidVersion).includes("/Users/private"),
      "invalid Worker health version leaked remote text into the diagnostic projection");
  }

  await assert.rejects(
    requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/large/healthz`, { proxyResolver: () => "" }),
    /size limit/,
  );
  const timedOut = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    timeoutMs: 10,
    proxyResolver: () => "",
    probe: (_url, options) => requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/slow/healthz`, options),
  });
  assert.equal(timedOut.error, "timeout");
  assert.equal(timedOut.networkRoute, "direct");
  const unavailable = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    proxyResolver: () => "",
    probe: (_url, options) => requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/unavailable/healthz`, options),
  });
  assert.equal(unavailable.error, "HTTP 503");

  const proxied = await requestWorkerHealthJson(`http://worker-health.example.invalid:${address(target).port}/healthz`, {
    proxyResolver: () => `http://127.0.0.1:${address(proxy).port}`,
  });
  assert.equal(proxied.statusCode, 200);
  assert.equal(proxied.networkRoute, "proxy");
  assert.equal(proxyConnects, 1);

  const environmentBefore = snapshotEnvironment(["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]);
  try {
    process.env.HTTP_PROXY = `http://127.0.0.1:${address(proxy).port}`;
    process.env.http_proxy = process.env.HTTP_PROXY;
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";
    const environmentProxied = await requestWorkerHealthJson(`http://worker-env.example.invalid:${address(target).port}/healthz`);
    assert.equal(environmentProxied.statusCode, 200);
    assert.equal(environmentProxied.networkRoute, "proxy");
    const connectsBeforeBypass = proxyConnects;
    process.env.NO_PROXY = "127.0.0.1";
    process.env.no_proxy = "127.0.0.1";
    const environmentBypass = await requestWorkerHealthJson(`http://127.0.0.1:${address(target).port}/healthz`);
    assert.equal(environmentBypass.statusCode, 200);
    assert.equal(environmentBypass.networkRoute, "direct");
    assert.equal(proxyConnects, connectsBeforeBypass);
  } finally {
    restoreEnvironment(environmentBefore);
  }

  const invalidProxy = await workerHealth(workerUrl, version, {
    expectedWorkerName,
    proxyResolver: () => "socks5://proxy.example.invalid:1080",
  });
  assert.equal(invalidProxy.error, "proxy_configuration");
  assert.equal(invalidProxy.networkRoute, "invalid-proxy-configuration");
  assert.equal(workerHealthUserReason(invalidProxy.error), "HTTP proxy configuration is invalid");
  assert.throws(() => proxyAgentForHttp("ftp://worker-health.example.invalid"), /must use http or https/);
  assert.equal(proxyAgentForWebSocket("wss://worker-health.example.invalid", () => "").mode, "direct");
  assert.throws(() => proxyAgentForWebSocket("https://worker-health.example.invalid"), /must use ws or wss/);

  assert.equal(workerHealthRequiresRedeploy("version_mismatch:1.0.0!=2.0.0"), true);
  assert.equal(workerHealthRequiresRedeploy("unexpected_health_response"), true);
  assert.equal(workerHealthRequiresRedeploy("HTTP 404"), true);
  assert.equal(workerHealthRequiresRedeploy("HTTP 503"), false);
  assert.equal(workerHealthRequiresRedeploy("timeout"), false);
  assert.equal(workerHealthError(Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" })), "timeout");
  assert.equal(workerHealthError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), "network_error");
  assert.equal(workerHealthError(Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" })), "tls_error");

  let probes = 0;
  const retried = await retryWorkerHealth(workerUrl, version, 3, {
    expectedWorkerName,
    wait: async () => {},
    probe: async () => {
      probes += 1;
      if (probes < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return { statusCode: 200, body: { ok: true, server: "machine-bridge-mcp", version } };
    },
  });
  assert.equal(retried.ok, true);
  assert.equal(probes, 3);
  let staleProbes = 0;
  const stale = await retryWorkerHealth(workerUrl, version, 4, {
    expectedWorkerName,
    wait: async () => {},
    probe: async () => {
      staleProbes += 1;
      return { statusCode: 404, body: null };
    },
  });
  assert.equal(stale.error, "HTTP 404");
  assert.equal(staleProbes, 4, "definitive stale evidence was not allowed to converge after deployment propagation");

  let configurationProbes = 0;
  const configuration = await retryWorkerHealth(workerUrl, version, 4, {
    expectedWorkerName,
    wait: async () => { throw new Error("non-retryable proxy configuration waited unexpectedly"); },
    probe: async () => {
      configurationProbes += 1;
      throw Object.assign(new Error("bad proxy"), { code: "http_proxy_configuration" });
    },
  });
  assert.equal(configuration.error, "proxy_configuration");
  assert.equal(configurationProbes, 1);

  await verifyDeploymentPropagationBudget();
  await verifyRecordedCurrentDeploymentDoesNotRedeploy();
  await verifyDeploymentIdempotency();
  await verifyPersistedDeploymentIdempotency();
  await verifyDefinitiveStalenessRedeploys();
  await verifyDeploymentUrlBoundaries();
  verifyWorkerNameSafety();
  verifyWorkerUrlParsing();

  console.log("worker deployment and proxy-aware health test ok");
} finally {
  await close(proxy);
  await close(target);
}

async function verifyDeploymentPropagationBudget() {
  const state = workerState("mbm-propagation-budget-test");
  const logs = [];
  let observedAttempts = 0;
  await ensureWorkerDeployment(state, {}, {
    packageRoot: root,
    expectedVersion: version,
    runWrangler: async (args) => args[0] === "whoami"
      ? { code: 0, stdout: "authenticated", stderr: "" }
      : { code: 0, stdout: "Deployed https://mbm-propagation-budget-test.account-example.workers.dev", stderr: "" },
    withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
    saveState: () => {},
    retryHealth: async (_url, _version, attempts) => {
      observedAttempts = attempts;
      return { ok: true, version, networkRoute: "direct" };
    },
    logger: recordingLogger(logs),
  });
  assert.equal(observedAttempts, 20, "post-deployment health verification retained the short propagation window");
  const serializedLogs = JSON.stringify(logs);
  assert(!serializedLogs.includes(state.worker.url) && !serializedLogs.includes(state.worker.name),
    "routine Worker deployment logs retained the private Worker endpoint or workspace-derived Worker name");
}

function verifyWorkerFingerprintPathBoundaries() {
  const fixture = mkdtempSync(join(os.tmpdir(), "mbm-worker-fingerprint-"));
  const outside = mkdtempSync(join(os.tmpdir(), "mbm-worker-fingerprint-outside-"));
  try {
    mkdirSync(join(fixture, "src", "worker"), { recursive: true });
    mkdirSync(join(fixture, "src", "shared"), { recursive: true });
    writeFileSync(join(fixture, "src", "worker", "index.ts"), "export const worker = true;\n");
    writeFileSync(join(fixture, "src", "shared", "value.ts"), "export const value = true;\n");
    writeFileSync(join(fixture, "wrangler.jsonc"), "{}\n");
    writeFileSync(join(fixture, "tsconfig.json"), "{}\n");
    const state = workerState("mbm-fingerprint-boundary");
    const baseline = workerDeploymentFingerprint(state, { packageRoot: fixture });
    assert.match(baseline, /^[0-9a-f]{64}$/);

    const collisionA = mkdtempSync(join(os.tmpdir(), "mbm-worker-fingerprint-collision-a-"));
    const collisionB = mkdtempSync(join(os.tmpdir(), "mbm-worker-fingerprint-collision-b-"));
    try {
      for (const target of [collisionA, collisionB]) {
        mkdirSync(join(target, "src", "worker"), { recursive: true });
        mkdirSync(join(target, "src", "shared"), { recursive: true });
        writeFileSync(join(target, "src", "worker", "index.ts"), "export const worker = true;\n");
        writeFileSync(join(target, "wrangler.jsonc"), "{}\n");
        writeFileSync(join(target, "tsconfig.json"), "{}\n");
      }
      writeFileSync(join(collisionA, "src", "shared", "a.ts"), "/b.tsX");
      mkdirSync(join(collisionB, "src", "shared", "a.ts"));
      writeFileSync(join(collisionB, "src", "shared", "a.ts", "b.ts"), "X");
      assert.equal("src/shared/a.ts" + "/b.tsX", "src/shared/a.ts/b.ts" + "X",
        "synthetic legacy fingerprint collision fixture is invalid");
      assert.notEqual(
        workerDeploymentFingerprint(state, { packageRoot: collisionA }),
        workerDeploymentFingerprint(state, { packageRoot: collisionB }),
        "length-framed Worker deployment fingerprint accepted an ambiguous file layout",
      );
    } finally {
      rmSync(collisionA, { recursive: true, force: true });
      rmSync(collisionB, { recursive: true, force: true });
    }
    rmSync(join(fixture, "wrangler.jsonc"));
    assert.throws(() => workerDeploymentFingerprint(state, { packageRoot: fixture }), /required source is missing/);
    writeFileSync(join(fixture, "wrangler.jsonc"), "{}\n");
    if (process.platform !== "win32") {
      const ancestorFixture = mkdtempSync(join(os.tmpdir(), "mbm-worker-fingerprint-ancestor-"));
      try {
        mkdirSync(join(ancestorFixture, "real-src", "worker"), { recursive: true });
        mkdirSync(join(ancestorFixture, "real-src", "shared"), { recursive: true });
        writeFileSync(join(ancestorFixture, "real-src", "worker", "index.ts"), "export const worker = true;\n");
        writeFileSync(join(ancestorFixture, "real-src", "shared", "value.ts"), "export const value = true;\n");
        writeFileSync(join(ancestorFixture, "wrangler.jsonc"), "{}\n");
        writeFileSync(join(ancestorFixture, "tsconfig.json"), "{}\n");
        symlinkSync(join(ancestorFixture, "real-src"), join(ancestorFixture, "src"), "dir");
        assert.throws(() => workerDeploymentFingerprint(state, { packageRoot: ancestorFixture }),
          /source must not be a symbolic link/,
          "symlinked Worker source ancestor was followed");
      } finally {
        rmSync(ancestorFixture, { recursive: true, force: true });
      }
      const external = join(outside, "external.ts");
      writeFileSync(external, "export const external = true;\n");
      rmSync(join(fixture, "src", "shared", "value.ts"));
      symlinkSync(external, join(fixture, "src", "shared", "value.ts"));
      assert.throws(() => workerDeploymentFingerprint(state, { packageRoot: fixture }), /must not be a symbolic link/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

async function verifyRecordedCurrentDeploymentDoesNotRedeploy() {
  const state = workerState("mbm-recorded-current-test");
  state.worker.url = "https://mbm-recorded-current-test.account-example.workers.dev";
  state.worker.mcpServerUrl = `${state.worker.url}/mcp`;
  state.worker.deployHash = workerDeploymentFingerprint(state, { packageRoot: root });
  state.worker.deployedVersion = version;
  let deploys = 0;
  let observedAttempts = 0;
  await assert.rejects(
    ensureWorkerDeployment(state, {}, {
      packageRoot: root,
      expectedVersion: version,
      retryHealth: async (_url, _version, attempts) => {
        observedAttempts = attempts;
        return { ok: false, error: "version_mismatch:1.0.0!=9.8.7", networkRoute: "direct" };
      },
      runWrangler: async (args) => {
        if (args[0] === "deploy") deploys += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
      saveState: () => {},
      logger: quietLogger(),
    }),
    error => error.code === "worker_health_unverified"
      && error.deploymentSucceeded === false
      && /No deployment was attempted because duplicating/.test(error.message),
  );
  assert.equal(observedAttempts, 20, "recorded current deployment did not receive the propagation verification budget");
  assert.equal(deploys, 0, "a recorded current deployment was duplicated after a version mismatch");
}

async function verifyDeploymentIdempotency() {
  const state = workerState("mbm-health-test");
  let deploys = 0;
  let saves = 0;
  const options = {
    packageRoot: root,
    runWrangler: async (args) => {
      if (args[0] === "whoami") return { code: 0, stdout: "authenticated", stderr: "" };
      if (args[0] === "deploy") {
        deploys += 1;
        return { code: 0, stdout: "Deployed https://mbm-health-test.account-example.workers.dev", stderr: "" };
      }
      throw new Error(`unexpected Wrangler command: ${args.join(" ")}`);
    },
    withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
    saveState: () => { saves += 1; },
    retryHealth: async () => ({ ok: false, error: "timeout" }),
    existingHealthAttempts: 1,
    deploymentHealthAttempts: 1,
    logger: quietLogger(),
    expectedVersion: version,
  };

  await assert.rejects(
    ensureWorkerDeployment(state, {}, options),
    error => error.code === "worker_health_unverified" && error.deploymentSucceeded === true && /fingerprint was saved/.test(error.message),
  );
  assert.equal(deploys, 1);
  assert.equal(saves, 1);
  assert.equal(state.worker.deployHash, workerDeploymentFingerprint(state, { packageRoot: root }));
  assert.equal(state.worker.deployedVersion, version);

  await assert.rejects(
    ensureWorkerDeployment(state, {}, options),
    error => error.code === "worker_health_unverified" && error.deploymentSucceeded === false && /No deployment was attempted/.test(error.message),
  );
  assert.equal(deploys, 1, "a transient health failure repeated the successful deployment");
  assert.equal(saves, 1, "verification-only retry mutated deployment state");
}

async function verifyPersistedDeploymentIdempotency() {
  const stateRoot = mkdtempSync(join(os.tmpdir(), "mbm-worker-persisted-state-"));
  const workspace = mkdtempSync(join(os.tmpdir(), "mbm-worker-persisted-workspace-"));
  try {
    const state = loadState(workspace, { stateDir: stateRoot });
    ensureWorkerSecrets(state, { workerName: "mbm-persisted-test" });
    saveState(state);
    let deploys = 0;
    const options = {
      packageRoot: root,
      runWrangler: async (args) => {
        if (args[0] === "whoami") return { code: 0, stdout: "authenticated", stderr: "" };
        if (args[0] === "deploy") {
          deploys += 1;
          return { code: 0, stdout: "Deployed https://mbm-persisted-test.account-example.workers.dev", stderr: "" };
        }
        throw new Error(`unexpected Wrangler command: ${args.join(" ")}`);
      },
      withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
      saveState,
      retryHealth: async () => ({ ok: false, error: "timeout" }),
      existingHealthAttempts: 1,
      deploymentHealthAttempts: 1,
      logger: quietLogger(),
      expectedVersion: version,
    };

    await assert.rejects(
      ensureWorkerDeployment(state, {}, options),
      error => error.code === "worker_health_unverified" && error.deploymentSucceeded === true,
    );
    assert.equal(deploys, 1);

    const reloaded = loadState(workspace, { stateDir: stateRoot });
    assert.equal(reloaded.worker.name, "mbm-persisted-test");
    assert.equal(reloaded.worker.url, "https://mbm-persisted-test.account-example.workers.dev");
    assert.equal(reloaded.worker.deployHash, workerDeploymentFingerprint(reloaded, { packageRoot: root }));
    await assert.rejects(
      ensureWorkerDeployment(reloaded, {}, options),
      error => error.code === "worker_health_unverified" && error.deploymentSucceeded === false,
    );
    assert.equal(deploys, 1, "a process restart repeated a deployment whose success fingerprint was persisted");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function verifyDefinitiveStalenessRedeploys() {
  const state = workerState("mbm-stale-test");
  state.worker.url = "https://mbm-stale-test.account-example.workers.dev";
  state.worker.mcpServerUrl = `${state.worker.url}/mcp`;
  state.worker.deployHash = workerDeploymentFingerprint(state, { packageRoot: root });
  let healthChecks = 0;
  let deploys = 0;
  await ensureWorkerDeployment(state, {}, {
    packageRoot: root,
    expectedVersion: version,
    retryHealth: async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? { ok: false, error: "version_mismatch:1.0.0!=9.8.7" }
        : { ok: true, version, networkRoute: "direct" };
    },
    runWrangler: async (args) => {
      if (args[0] === "whoami") return { code: 0, stdout: "authenticated", stderr: "" };
      if (args[0] === "deploy") {
        deploys += 1;
        return { code: 0, stdout: "Deployed https://mbm-stale-test.account-example.workers.dev", stderr: "" };
      }
      throw new Error(`unexpected Wrangler command: ${args.join(" ")}`);
    },
    withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
    saveState: () => {},
    logger: quietLogger(),
  });
  assert.equal(deploys, 1);
  assert.equal(healthChecks, 2);
}

async function verifyDeploymentUrlBoundaries() {
  const missing = workerState("mbm-missing-url-test");
  let missingSaves = 0;
  await assert.rejects(
    ensureWorkerDeployment(missing, {}, {
      packageRoot: root,
      expectedVersion: version,
      runWrangler: async (args) => args[0] === "whoami"
        ? { code: 0, stdout: "authenticated", stderr: "" }
        : { code: 0, stdout: "uploaded without a public URL", stderr: "" },
      withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
      saveState: () => { missingSaves += 1; },
      retryHealth: async () => { throw new Error("health must not run without a Worker URL"); },
      logger: quietLogger(),
    }),
    /deployment fingerprint was not saved/,
  );
  assert.equal(missingSaves, 0);

  for (const unrelated of [
    "See https://example.test/mcp for documentation",
    "Health details: https://example.test/healthz",
    "Deployed https://other-worker.account-example.workers.dev",
    "Deployed https://mbm-missing-url-test.account-example.workers.dev/mcp",
  ]) {
    const poisoned = workerState("mbm-missing-url-test");
    let poisonedSaves = 0;
    await assert.rejects(
      ensureWorkerDeployment(poisoned, {}, {
        packageRoot: root, expectedVersion: version,
        runWrangler: async (args) => args[0] === "whoami"
          ? { code: 0, stdout: "authenticated", stderr: "" }
          : { code: 0, stdout: unrelated, stderr: "" },
        withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
        saveState: () => { poisonedSaves += 1; },
        retryHealth: async () => { throw new Error("health must not run for an invalid extracted URL"); },
        logger: quietLogger(),
      }),
      /deployment fingerprint was not saved/,
    );
    assert.equal(poisonedSaves, 0, `unrelated URL poisoned persisted deployment state: ${unrelated}`);
    assert.equal(poisoned.worker.url, undefined);
  }

  const recorded = workerState("mbm-recorded-url-test");
  recorded.worker.url = "https://mbm-recorded-url-test.account-example.workers.dev";
  recorded.worker.mcpServerUrl = `${recorded.worker.url}/mcp`;
  let recordedSaves = 0;
  await ensureWorkerDeployment(recorded, { forceWorker: true }, {
    packageRoot: root,
    expectedVersion: version,
    runWrangler: async (args) => args[0] === "whoami"
      ? { code: 0, stdout: "authenticated", stderr: "" }
      : { code: 0, stdout: "uploaded without a public URL", stderr: "" },
    withSecretsFile: async (_state, callback) => callback("synthetic-secrets.json"),
    saveState: () => { recordedSaves += 1; },
    retryHealth: async () => ({ ok: true, version, networkRoute: "direct" }),
    logger: quietLogger(),
  });
  assert.equal(recordedSaves, 1);
  assert.equal(recorded.worker.url, "https://mbm-recorded-url-test.account-example.workers.dev");
}

function verifyWorkerNameSafety() {
  const state = workerState("mbm-original-test");
  state.worker.url = "https://mbm-original-test.account-example.workers.dev";
  state.worker.mcpServerUrl = `${state.worker.url}/mcp`;
  state.worker.deployHash = "old-hash";
  assert.throws(
    () => ensureWorkerSecrets(state, { workerName: "mbm-replacement-test" }),
    /would create another Worker/,
  );
  assert.equal(state.worker.name, "mbm-original-test");

  ensureWorkerSecrets(state, { workerName: "mbm-replacement-test", allowWorkerRename: true });
  assert.equal(state.worker.name, "mbm-replacement-test");
  assert.deepEqual(state.worker.previousNames, ["mbm-original-test"]);
  assert.equal(state.worker.url, undefined);
  assert.equal(state.worker.mcpServerUrl, undefined);
  assert.equal(state.worker.deployHash, undefined);
}

function verifyWorkerUrlParsing() {
  assert.equal(
    extractWorkerUrl("Docs https://example.test/mcp\nDeployed https://mbm-url-test.account-example.workers.dev\n", "mbm-url-test"),
    "https://mbm-url-test.account-example.workers.dev",
  );
  for (const invalid of [
    "See https://example.test/mcp for details",
    "Health https://example.test/healthz",
    "Deployed https://mbm-url-test.account-example.workers.dev/mcp",
    "Deployed https://mbm-other-test.account-example.workers.dev",
  ]) assert.equal(extractWorkerUrl(invalid, "mbm-url-test"), "");
  assert.equal(workerUrlMatchesName("https://mbm-url-test.account-example.workers.dev", "mbm-url-test"), true);
  assert.equal(workerUrlMatchesName("https://MBM-URL-TEST.ACCOUNT-EXAMPLE.WORKERS.DEV/", "mbm-url-test"), true);
  assert.equal(workerUrlMatchesName("https://mbm-url-test.account-example.workers.dev/mcp", "mbm-url-test"), false);
  assert.equal(workerUrlMatchesName("https://mbm-other-test.account-example.workers.dev", "mbm-url-test"), false);
  assert.equal(workerUrlMatchesName("https://example.com", "mbm-url-test"), false);
}


function snapshotEnvironment(names) {
  return Object.fromEntries(names.map(name => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function workerState(name) {
  return {
    worker: {
      name,
      deviceIdentity: createDeviceIdentity(),
      oauthTokenVersion: "token_version_test_secret_abcdefghijklmnopqrstuvwxyz",
    },
  };
}

function quietLogger() {
  return Object.fromEntries(["debug", "info", "warn", "success"].map(level => [level, () => {}]));
}

function recordingLogger(records) {
  return Object.fromEntries(["debug", "info", "warn", "success"].map(level => [level, (message, fields) => records.push({ level, message, fields })]));
}

function address(server) {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("test server did not expose a TCP address");
  return value;
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise());
  });
}
