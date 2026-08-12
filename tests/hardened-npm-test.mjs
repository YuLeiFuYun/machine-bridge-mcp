import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureHardenedNpm,
  hardenedNpmIdentity,
  prepareHardenedNpm,
  verifyHardenedNpm,
} from "../src/local/hardened-npm.mjs";
import { downloadHardenedNpmArtifact } from "../src/local/hardened-npm-download.mjs";
import { createHardenedDownloadTimeout } from "../src/local/hardened-npm-download-timeout.mjs";
import { createHardenedNpmSession, settleHardenedNpmSession } from "../scripts/hardened-npm-session.mjs";
import { operationalErrorCode, throwOperationalOrIntegrity } from "../src/local/private-toolchain-integrity.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-hardened-npm-test-"));
try {
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);
  const definitions = [
    { name: "npm", version: "12.0.1", maximumBytes: 2 * 1024 * 1024 },
    { name: "undici", version: "6.28.0", maximumBytes: 512 * 1024 },
    { name: "brace-expansion", version: "5.0.9", maximumBytes: 512 * 1024 },
  ];
  const bytesByName = new Map();
  const artifacts = definitions.map((definition) => {
    const bytes = createPackageArchive(fixtures, definition);
    bytesByName.set(definition.name, bytes);
    return {
      ...definition,
      url: `https://registry.npmjs.org/${definition.name}/-/${definition.name}-${definition.version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  });

  const session = await createHardenedNpmSession({
    tempRoot: root,
    hardenedNpm: {
      artifacts,
      readArtifact: (artifact) => bytesByName.get(artifact.name),
    },
  });
  assert.equal(session.version, "12.0.1");
  assert.equal(session.undiciVersion, "6.28.0");
  session.dispose();
  assert.equal(session.dispose(), undefined, "hardened npm session disposal was not idempotent");
  const primary = new Error("primary failure");
  const cleanup = new Error("cleanup failure");
  const aggregated = settleHardenedNpmSession({ dispose() { throw cleanup; } }, primary, "combined failure");
  assert(aggregated instanceof AggregateError && aggregated.message === "combined failure");
  assert.deepEqual(aggregated.errors, [primary, cleanup]);
  assert.equal(settleHardenedNpmSession({ dispose() {} }, primary), primary);
  assert.equal(settleHardenedNpmSession({ dispose() { throw cleanup; } }), cleanup);
  for (const code of ["EDQUOT", "ENOMEM", "EAGAIN", "ENOBUFS", "EINTR", "ESTALE"]) {
    const operational = Object.assign(new Error(`synthetic ${code}`), { code });
    assert.equal(operationalErrorCode(operational), code, `${code} was not classified as operational`);
    assert.throws(() => throwOperationalOrIntegrity(operational, "must not reconstruct"), error => error === operational);
  }

  const preparedRoot = join(root, "prepared");
  const prepared = await prepareHardenedNpm(preparedRoot, {
    artifacts,
    readArtifact: (artifact) => bytesByName.get(artifact.name),
  });
  assert.equal(prepared.version, "12.0.1");
  assert.equal(prepared.undiciVersion, "6.28.0");
  assert.equal(prepared.braceExpansionVersion, "5.0.9");
  assert.equal(verifyHardenedNpm(preparedRoot, { artifacts }).cli, prepared.cli);

  let downloads = 0;
  const parent = join(root, "toolchains");
  const options = {
    artifacts,
    readArtifact: (artifact) => {
      downloads += 1;
      return bytesByName.get(artifact.name);
    },
  };
  const first = await ensureHardenedNpm(parent, options);
  assert.equal(downloads, 3);
  const second = await ensureHardenedNpm(parent, options);
  assert.equal(first.root, second.root);
  assert.equal(downloads, 3, "verified hardened npm was downloaded again");
  const timeout = Object.assign(new Error("synthetic npm verification timeout"), { code: "ETIMEDOUT" });
  await assert.rejects(
    ensureHardenedNpm(parent, { ...options, run: () => { throw timeout; } }),
    error => error === timeout,
  );
  assert.equal(downloads, 3, "operational hardened npm verification failure triggered destructive reconstruction");
  const markerPath = join(first.root, ".machine-bridge-mcp-hardened-npm.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  writeFileSync(markerPath, `${JSON.stringify({ ...marker, undici: "6.27.0" })}\n`);
  await ensureHardenedNpm(parent, options);
  assert.equal(downloads, 6, "hardened npm accepted a marker with mismatched component versions");
  writeFileSync(join(first.root, "package", "node_modules", "undici", "package.json"), '{"name":"undici","version":"6.27.0"}\n');
  const repaired = await ensureHardenedNpm(parent, options);
  assert.equal(repaired.undiciVersion, "6.28.0");
  assert.equal(downloads, 9, "tampered hardened npm was not reconstructed");
  if (process.platform !== "win32") {
    const cli = join(first.root, "package", "bin", "npm-cli.js");
    rmSync(cli);
    symlinkSync("../package.json", cli);
    await ensureHardenedNpm(parent, options);
    assert.equal(downloads, 12, "symlinked hardened npm CLI was accepted instead of reconstructed");
  }

  const retryDelays = [];
  const transientRequest = fakeDownloadSequence([
    { error: Object.assign(new Error("synthetic registry timeout"), { code: "ETIMEDOUT" }) },
    { statusCode: 503 },
    { statusCode: 200, body: bytesByName.get("npm") },
  ]);
  const retriedDownload = await downloadHardenedNpmArtifact(artifacts[0], {
    request: transientRequest, proxyAgentForUrl: () => ({ agent: null }), sleep: (milliseconds) => { retryDelays.push(milliseconds); },
  });
  assert.deepEqual(retriedDownload, bytesByName.get("npm"), "hardened npm transient retry changed successful tarball bytes");
  assert.equal(transientRequest.calls, 3, "hardened npm did not retry transient timeout/503 failures to success");
  assert.deepEqual(retryDelays, [750, 1500], "hardened npm transient retry lost bounded linear backoff");

  const slowScheduler = createManualTimerScheduler();
  const slowBody = bytesByName.get("npm");
  const slowDownload = await downloadHardenedNpmArtifact(artifacts[0], {
    request: fakeProgressiveDownload(slowScheduler, slowBody),
    proxyAgentForUrl: () => ({ agent: null }),
    downloadTimeout: { idleMs: 100, maximumMs: 500, schedule: slowScheduler.setTimeout, cancel: slowScheduler.clearTimeout },
  });
  assert.deepEqual(slowDownload, slowBody, "hardened npm rejected a bounded download that kept making progress beyond one idle interval");

  const stalledScheduler = createManualTimerScheduler();
  const timeoutErrors = [];
  createHardenedDownloadTimeout("npm", { destroy: (error) => timeoutErrors.push(error) }, {
    idleMs: 100, maximumMs: 500, schedule: stalledScheduler.setTimeout, cancel: stalledScheduler.clearTimeout,
  });
  stalledScheduler.advance(100);
  assert.equal(timeoutErrors[0]?.code, "ETIMEDOUT", "hardened npm idle timeout lost its transient timeout classification");
  assert.match(timeoutErrors[0]?.message || "", /download stalled/, "hardened npm idle timeout stopped distinguishing a real stall");

  const maximumScheduler = createManualTimerScheduler();
  const maximumErrors = [];
  const maximumTimeout = createHardenedDownloadTimeout("npm", { destroy: (error) => maximumErrors.push(error) }, {
    idleMs: 100, maximumMs: 250, schedule: maximumScheduler.setTimeout, cancel: maximumScheduler.clearTimeout,
  });
  maximumScheduler.advance(90); maximumTimeout.progress();
  maximumScheduler.advance(90); maximumTimeout.progress();
  maximumScheduler.advance(70);
  assert.match(maximumErrors[0]?.message || "", /maximum duration/, "hardened npm progress could extend a download beyond its absolute bound");
  maximumTimeout.progress();
  const clearedScheduler = createManualTimerScheduler();
  const clearedErrors = [];
  const clearedTimeout = createHardenedDownloadTimeout("npm", { destroy: (error) => clearedErrors.push(error) }, {
    idleMs: 100, maximumMs: 250, schedule: clearedScheduler.setTimeout, cancel: clearedScheduler.clearTimeout,
  });
  clearedTimeout.clear(); clearedTimeout.clear(); clearedTimeout.progress(); clearedScheduler.advance(500);
  assert.equal(clearedErrors.length, 0, "cleared hardened npm timeout fired after successful settlement");

  const permanentRequest = fakeDownloadSequence([
    { error: Object.assign(new Error("synthetic certificate rejection"), { code: "CERT_HAS_EXPIRED" }) },
  ]);
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { request: permanentRequest, proxyAgentForUrl: () => ({ agent: null }), sleep: () => {} }),
    /certificate rejection/,
  );
  assert.equal(permanentRequest.calls, 1, "hardened npm retried a non-transient TLS/certificate failure");

  const redirectRequest = fakeRequest(302);
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { request: redirectRequest, proxyAgentForUrl: () => ({ agent: null }), sleep: () => {} }),
    /HTTP 302/,
  );
  assert.equal(redirectRequest.calls, 1, "hardened npm followed or retried a registry redirect");

  await assert.rejects(
    downloadHardenedNpmArtifact({ ...artifacts[0], url: artifacts[0].url.replace("https:", "http:") }, { request: fakeRequest(200) }),
    /not an exact HTTPS registry URL/,
  );
  const setupFailure = new Error("synthetic request setup failure");
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { agent: null, request: () => { throw setupFailure; } }),
    error => error === setupFailure,
  );
  const defaultAgentRequest = fakeDownloadSequence([{ statusCode: 200, body: bytesByName.get("npm") }]);
  assert.deepEqual(
    await downloadHardenedNpmArtifact(artifacts[0], { request: defaultAgentRequest, proxyEnv: {} }),
    bytesByName.get("npm"),
    "hardened npm default proxy-aware HTTPS agent changed artifact bytes",
  );
  for (const proxyEnv of [
    "not-an-object",
    { HTTPS_PROXY: "bad proxy" },
    { HTTPS_PROXY: "ftp://proxy.example.invalid" },
    { HTTPS_PROXY: "https://proxy.example.invalid/\nheader" },
    { NO_PROXY: "example.invalid\nother.invalid" },
  ]) {
    await assert.rejects(
      downloadHardenedNpmArtifact(artifacts[0], { request: fakeRequest(200), proxyEnv }),
      error => error?.code === "http_proxy_configuration",
    );
  }
  const tooLarge = { ...artifacts[0], maximumBytes: bytesByName.get("npm").length - 1 };
  await assert.rejects(
    downloadHardenedNpmArtifact(tooLarge, { request: fakeDownloadSequence([{ statusCode: 200, body: bytesByName.get("npm") }]), agent: null }),
    /exceeds its byte limit/,
  );
  await assert.rejects(
    downloadHardenedNpmArtifact(tooLarge, { request: fakeDownloadSequence([{ statusCode: 200, body: bytesByName.get("npm"), omitLength: true }]), agent: null }),
    error => error?.code === "ERR_RESPONSE_TOO_LARGE",
  );
  const responseFailure = new Error("synthetic response stream failure");
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { request: fakeDownloadSequence([{ statusCode: 200, responseError: responseFailure }]), agent: null }),
    error => error === responseFailure,
  );
  const exhaustedTransient = fakeDownloadSequence([{ error: Object.assign(new Error("persistent synthetic timeout"), { code: "ETIMEDOUT" }) }]);
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { request: exhaustedTransient, agent: null, sleep: () => {} }),
    /persistent synthetic timeout/,
  );
  assert.equal(exhaustedTransient.calls, 3, "hardened npm did not stop after its bounded transient retry count");

  const deceptiveOrigin = artifacts.map((item) => ({ ...item }));
  deceptiveOrigin[0].url = deceptiveOrigin[0].url.replace("registry.npmjs.org/", "registry.npmjs.org.evil/");
  assert.throws(() => hardenedNpmIdentity(deceptiveOrigin), /artifact metadata is invalid/);

  const identity = hardenedNpmIdentity(artifacts);
  assert.match(identity.directoryName, /^npm-12\.0\.1-hardened-[a-f0-9]{16}$/);
  const corrupt = artifacts.map((item) => ({ ...item }));
  corrupt[1].integrity = corrupt[1].integrity.replace(/^sha512-./, (value) => value === "sha512-A" ? "sha512-B" : "sha512-A");
  await assert.rejects(
    prepareHardenedNpm(join(root, "corrupt"), {
      artifacts: corrupt,
      readArtifact: (artifact) => bytesByName.get(artifact.name),
    }),
    /failed SHA-512 verification/,
  );

  console.log("hardened npm bootstrap test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function createManualTimerScheduler() {
  let now = 0; let nextId = 1; const timers = new Map();
  const setTimer = (callback, milliseconds) => { const id = nextId++; timers.set(id, { at: now + milliseconds, callback }); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  return {
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due; timers.delete(id); now = timer.at; timer.callback();
      }
      now = target;
    },
  };
}

function fakeProgressiveDownload(scheduler, body) {
  return () => {
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) request.emit("error", error); };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200; response.headers = { "content-length": String(body.length) };
        response.resume = () => {}; response.destroy = (error) => { if (error) response.emit("error", error); };
        request.emit("response", response);
        const midpoint = Math.ceil(body.length / 2);
        scheduler.advance(75); response.emit("data", body.subarray(0, midpoint));
        scheduler.advance(75); response.emit("data", body.subarray(midpoint));
        scheduler.advance(75); response.emit("end");
      });
    };
    return request;
  };
}

function fakeRequest(statusCode) { return fakeDownloadSequence([{ statusCode }]); }

function fakeDownloadSequence(outcomes) {
  const create = () => {
    const outcome = outcomes[Math.min(create.calls, outcomes.length - 1)];
    create.calls += 1;
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) queueMicrotask(() => request.emit("error", error)); };
    request.end = () => {
      queueMicrotask(() => {
        if (outcome.error) { request.emit("error", outcome.error); return; }
        const response = new EventEmitter();
        response.statusCode = outcome.statusCode;
        response.headers = outcome.body && !outcome.omitLength ? { "content-length": String(outcome.body.length) } : {};
        response.resume = () => {};
        response.destroy = (error) => {
          response.destroyedError = error || null;
          if (error) queueMicrotask(() => response.emit("error", error));
        };
        request.emit("response", response);
        if (outcome.statusCode === 200) {
          if (outcome.responseError) { response.emit("error", outcome.responseError); return; }
          if (outcome.body?.length) response.emit("data", outcome.body);
          if (!response.destroyedError) response.emit("end");
        }
      });
    };
    return request;
  };
  create.calls = 0;
  return create;
}

function createPackageArchive(fixtures, definition) {
  const source = join(fixtures, `${definition.name}-source`);
  const packageDirectory = join(source, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify({ name: definition.name, version: definition.version })}\n`);
  if (definition.name === "npm") {
    const bin = join(packageDirectory, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), `process.stdout.write(${JSON.stringify(`${definition.version}\n`)});\n`);
    for (const [name, version] of [["undici", "6.27.0"], ["brace-expansion", "5.0.7"]]) {
      const dependency = join(packageDirectory, "node_modules", name);
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dependency, "package.json"), `${JSON.stringify({ name, version })}\n`);
    }
  }
  const archive = join(fixtures, `${definition.name}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
  return readFileSync(archive);
}
