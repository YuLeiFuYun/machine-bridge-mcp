import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { cfAuthenticationResult, cfDeploymentAccount, ensureCfAuthenticated } from "../src/local/cf-authentication.mjs";
import { validateCfBuildOutput, withCfProject } from "../src/local/cf-project.mjs";
import { workerDeploymentSourceSnapshot } from "../src/local/worker-deployment-fingerprint.mjs";

const authenticated = { code: 0, stdout: JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: "1".repeat(32) }] }) };
for (const stdout of ["", "not json", "null", "[]", '{"authenticated":false}', '{"authenticated":"true"}',
  '{"authenticated":true,"tokenValid":false}']) {
  const calls = [];
  await assert.rejects(ensureCfAuthenticated({
    runCf: async args => { calls.push(args); return { code: 0, stdout }; },
  }), error => error.code === "worker_authentication_required" && error.sideEffectsStarted === false);
  assert.deepEqual(calls, [["auth", "whoami"]], "unauthenticated cf opened interactive login");
}
assert.equal(cfAuthenticationResult({ ...authenticated, stdout_truncated_bytes: 1 }).authenticated, false);
assert.equal(cfAuthenticationResult({ ...authenticated, code: 1 }).authenticated, false);
assert.equal(cfAuthenticationResult(authenticated).authenticated, true);
assert.equal(cfDeploymentAccount(cfAuthenticationResult(authenticated), {}), "1".repeat(32));
assert.throws(() => cfDeploymentAccount({ accounts: [] }, {}), /CLOUDFLARE_ACCOUNT_ID/);
assert.throws(() => cfDeploymentAccount({ accounts: [{ id: "1".repeat(32) }] }, { CLOUDFLARE_ACCOUNT_ID: "2".repeat(32) }), /accessible/);

for (const id of [["1".repeat(32)], { value: "1".repeat(32) }, null, 111]) {
  const result = cfAuthenticationResult({ code: 0, stdout: JSON.stringify({ authenticated: true, accounts: [{ id }] }) });
  assert.deepEqual(result.accounts, [], "cf account ID was accepted through scalar coercion");
}
for (const tokenValid of ["true", "false", 1, [], null]) {
  assert.equal(cfAuthenticationResult({ code: 0, stdout: JSON.stringify({ authenticated: true, tokenValid }) }).authenticated, false);
}
for (const configured of [["1".repeat(32)], 111, "", null]) {
  assert.throws(() => cfDeploymentAccount({ accounts: [] }, { CLOUDFLARE_ACCOUNT_ID: configured }), /accessible/);
}
assert.equal(cfDeploymentAccount(cfAuthenticationResult({ code: 0, stdout: JSON.stringify({
  authenticated: true, accounts: [{ id: "A".repeat(32) }],
}) }), { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) }), "a".repeat(32), "hex case changed account identity");

let probes = 0;
const loginCalls = [];
const loggedIn = await ensureCfAuthenticated({
  interactive: true, logger: {},
  runCf: async args => {
    loginCalls.push(args);
    if (args[1] === "login") return { code: 0 };
    probes += 1;
    return probes === 1 ? { code: 0, stdout: '{"authenticated":false}' } : authenticated;
  },
});
assert.equal(loggedIn.login_performed, true);
assert.deepEqual(loginCalls.map(args => args.slice(0, 2)), [["auth", "whoami"], ["auth", "login"], ["auth", "whoami"]]);
assert.deepEqual(loginCalls[1].slice(2), ["--scopes","account-settings.read","user-details.read","workers-scripts.read","workers-scripts.write","workers-scripts.bind","workers-routes.read","workers-routes.write","workers-observability.read","workers-observability.write","offline"]);

const root = mkdtempSync(join(tmpdir(), "mbm-cf-project-test-"));
try {
  const toolchain = join(root, "toolchain");
  const source = join(root, "source");
  mkdirSync(join(toolchain, "node_modules"), { recursive: true });
  writeFileSync(join(toolchain, "package.json"), JSON.stringify({ dependencies: { wrangler: "4.149.0" } }));
  for (const file of ["src/worker/index.ts", "src/shared/value.ts", "wrangler.jsonc", "cloudflare.config.ts",
    "wrangler.config.ts", "tsconfig.json", "src/local/wrangler-toolchain/package.json",
    "src/local/wrangler-toolchain/package-lock.json"]) {
    const target = join(source, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "snapshot bytes\n");
  }
  writeFileSync(join(source, ".env"), "ignored fixture\n");
  const snapshot = workerDeploymentSourceSnapshot(source);
  assert(!snapshot.files.some(file => file.path === ".env"), "project dotenv was copied");
  writeFileSync(join(source, "src/worker/index.ts"), "changed after snapshot\n");
  let observedProject;
  await withCfProject(snapshot, "mbm-cf-test", async project => {
    observedProject = project.cwd;
    assert.equal(readFileSync(join(project.cwd, "src/worker/index.ts"), "utf8"), "snapshot bytes\n");
    assert.equal(existsSync(join(project.cwd, ".env")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(project.cwd, "package.json"), "utf8")).devDependencies,
      { wrangler: "4.149.0" }, "private project did not declare its audited build provider");
    assert.equal(project.env.MBM_WORKER_NAME, "mbm-cf-test");
    assert.equal(project.env.CLOUDFLARE_ACCOUNT_ID, "1".repeat(32));
    assert.equal(validateCfBuildOutput(project.cwd, "mbm-cf-test").name, "mbm-cf-test");
  }, projectOptions(toolchain));
  assert.equal(existsSync(observedProject), false, "successful project leaked its private staging directory");

  for (const mutation of [
    config => { config.name = "other-worker"; },
    config => { config.exports.BridgeRoom.storage = "kv"; },
    config => { config.env.BRIDGE.worker = "other-worker"; },
    config => { config.env.STATEFUL_RATE_LIMITER.namespace = "other-namespace"; },
    config => { config.unsafe.metadata.keep_bindings = []; },
    config => { config.env.BRIDGE.type = "text"; },
    config => { config.env.STATEFUL_RATE_LIMITER.type = "text"; },
    config => { config.env.STATEFUL_RATE_LIMITER.simple.limit = 12000; },
    config => { config.env.STATEFUL_GLOBAL_RATE_LIMITER.simple.period = "60"; },
  ]) {
    let callbackCalled = false;
    await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => { callbackCalled = true; },
      projectOptions(toolchain, mutation)), /deployment contract/);
    assert.equal(callbackCalled, false, "invalid artifact reached secret/deployment callback");
  }
  let invalidNameInitializations = 0;
  for (const invalid of [["mbm-cf-test"], { name: "mbm-cf-test" }, 123, null, undefined]) {
    await assert.rejects(withCfProject(snapshot, invalid, async () => {}, {
      ensureToolchain: async () => { invalidNameInitializations += 1; return toolchain; },
    }), /Invalid Worker deployment name/);
  }
  assert.equal(invalidNameInitializations, 0, "invalid Worker identity initialized the deployment toolchain");

  await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => {}, projectOptions(toolchain, config => {
    config.manifest.modules = { "index.js": { type: "esm" }, "../worker.config.json": { type: "esm" } };
  })), /escapes its bundle/);
  await withCfProject(snapshot, "mbm-cf-test", async () => {}, {
    ...projectOptions(toolchain),
    runCf: async (_args, project) => {
      writeBuild(project.cwd, config => {
        for (let index = 0; index < 255; index += 1) config.manifest.modules["module-" + index + ".js"] = { type: "esm" };
      });
      const bundle = join(project.cwd, ".cloudflare/output/v0/workers/default/bundle");
      for (let index = 0; index < 255; index += 1) writeFileSync(join(bundle, "module-" + index + ".js"), "");
    },
  });
  await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => {}, projectOptions(toolchain, config => {
    for (let index = 0; index < 256; index += 1) config.manifest.modules["module-" + index + ".js"] = { type: "esm" };
  })), /module limit/, "over-budget manifest read nonexistent files before bounding its module count");

  await withCfProject(snapshot, "mbm-cf-test", async project => {
    assert.equal(validateCfBuildOutput(project.cwd, "mbm-cf-test").name, "mbm-cf-test");
    const output = join(project.cwd, ".cloudflare/output/v0/workers/default");
    const configPath = join(output, "worker.config.json");
    const config = JSON.parse(readFileSync(configPath));
    config.manifest.modules["overflow.js"] = { type: "esm" };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(join(output, "bundle/overflow.js"), "x");
    assert.throws(() => validateCfBuildOutput(project.cwd, "mbm-cf-test"), /exceeds 0 bytes|byte limit/);
  }, {
    ...projectOptions(toolchain),
    runCf: async (_args, project) => {
      writeBuild(project.cwd, config => { config.manifest.modules["second.js"] = { type: "esm" }; });
      const bundle = join(project.cwd, ".cloudflare/output/v0/workers/default/bundle");
      fs.truncateSync(join(bundle, "index.js"), 16 * 1024 * 1024);
      writeFileSync(join(bundle, "second.js"), "");
      fs.truncateSync(join(bundle, "second.js"), 16 * 1024 * 1024);
    },
  });

  const originalRemove = fs.rmSync;
  for (const failureAt of ["build", "callback", "success"]) {
    const primary = new Error("Synthetic primary failure");
    const cleanup = new Error("Synthetic cleanup failure");
    let blockedProject;
    fs.rmSync = (target, ...args) => {
      if (target === blockedProject) throw cleanup;
      return originalRemove(target, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => {
        if (failureAt === "callback") throw primary;
      }, {
        ...projectOptions(toolchain),
        runCf: async (_args, project) => {
          blockedProject = project.cwd;
          writeBuild(project.cwd);
          if (failureAt === "build") throw primary;
        },
      }), error => failureAt === "success" ? error === cleanup
        : error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
      "private cleanup erased the primary failure or hid incomplete cleanup");
    } finally {
      fs.rmSync = originalRemove;
      syncBuiltinESMExports();
      if (blockedProject) rmSync(blockedProject, { recursive: true, force: true });
    }
  }
  let failedProject;
  await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => { throw new Error("unexpected callback"); }, {
    ensureToolchain: async () => toolchain,
    runCf: async (_args, project) => { failedProject = project.cwd; throw new Error("synthetic build failure"); },
  }), /synthetic build failure/);
  assert.equal(existsSync(failedProject), false, "failed build leaked its private project");
  await assert.rejects(withCfProject({ files: [{ path: "../escape", content: Buffer.from("x") }] },
    "mbm-cf-test", async () => {}, projectOptions(toolchain)), /escapes/);
  assert.equal(existsSync(join(toolchain, "escape")), false);

  if (process.platform !== "win32") {
    await assert.rejects(withCfProject(snapshot, "mbm-cf-test", async () => {}, {
      ...projectOptions(toolchain),
      runCf: async (_args, project) => {
        writeBuild(project.cwd);
        const cfg = join(project.cwd, ".cloudflare/output/v0/workers/default/worker.config.json");
        const outside = join(root, "linked-artifact.json");
        writeFileSync(outside, readFileSync(cfg));
        rmSync(cfg);
        symlinkSync(outside, cfg);
      },
    }), /must not be a symbolic link/);
  }

  const deepRoot = join(source, "src/worker/deep");
  let deepest = deepRoot;
  for (let depth = 0; depth < 66; depth += 1) { deepest = join(deepest, "d"); mkdirSync(deepest, { recursive: true }); }
  assert.throws(() => workerDeploymentSourceSnapshot(source), /depth limit/, "unbounded recursion was accepted");
  rmSync(deepRoot, { recursive: true, force: true });
  const broadRoot = join(source, "src/worker/broad");
  mkdirSync(broadRoot);
  for (let index = 0; index < 8193; index += 1) writeFileSync(join(broadRoot, "ignored-" + index + ".txt"), "");
  assert.throws(() => workerDeploymentSourceSnapshot(source), /entry limit/, "ignored files bypassed traversal budget");
  rmSync(broadRoot, { recursive: true, force: true });
  const fileRoot = join(source, "src/worker/files");
  mkdirSync(fileRoot);
  const originalCount = workerDeploymentSourceSnapshot(source).files.length;
  for (let index = originalCount; index < 4096; index += 1) writeFileSync(join(fileRoot, "file-" + index + ".ts"), "");
  assert.equal(workerDeploymentSourceSnapshot(source).files.length, 4096, "valid file-count boundary was rejected");
  writeFileSync(join(fileRoot, "one-more.ts"), "");
  assert.throws(() => workerDeploymentSourceSnapshot(source), /4096 files/, "file-count overflow was accepted");
  rmSync(fileRoot, { recursive: true, force: true });

  assert.deepEqual(readFileSync(join(source, "src/worker/index.ts"), "utf8"), "changed after snapshot\n");
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 });
}
console.log("cf authentication, private snapshot, artifact identity, and cleanup tests ok");

function projectOptions(toolchain, mutation = () => {}) {
  return {
    ensureToolchain: async options => {
      assert.equal(typeof options.runCommand, "function", "private project initialization requires an executable runner");
      return toolchain;
    },
    env: { CLOUDFLARE_ACCOUNT_ID: "1".repeat(32) },
    runCf: async (args, project) => { assert.deepEqual(args, ["build"]); writeBuild(project.cwd, mutation); },
  };
}

function writeBuild(directory, mutation = () => {}) {
  const output = join(directory, ".cloudflare/output/v0/workers/default");
  mkdirSync(join(output, "bundle"), { recursive: true });
  const config = {
    name: "mbm-cf-test", exports: { BridgeRoom: { type: "durable-object", storage: "sqlite" } },
    env: { BRIDGE: { type: "durable-object", worker: "mbm-cf-test", exportName: "BridgeRoom" },
      STATEFUL_GLOBAL_RATE_LIMITER: { type: "rate-limit", namespace: "4301702", simple: { limit: 1200, period: 60 } },
      STATEFUL_RATE_LIMITER: { type: "rate-limit", namespace: "4301701", simple: { limit: 120, period: 60 } } },
    unsafe: { metadata: { keep_bindings: ["plain_text", "json", "secret_text", "secret_key"] } },
    manifest: { type: "complete", mainModule: "index.js", modules: { "index.js": { type: "esm" } } },
  };
  mutation(config);
  writeFileSync(join(output, "worker.config.json"), JSON.stringify(config));
  writeFileSync(join(output, "bundle/index.js"), "export default {};\n");
}
