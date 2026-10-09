import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { CF_NETWORK_ARTIFACT } from "../src/local/cf-network-integrity.mjs";
import { stopFixtureChild, waitForFixtureReady } from "./fixtures/child-fixture.mjs";
import { resolveNpmCli } from "../src/local/npm-cli.mjs";
import {
  ensureCloudflareToolchain,
  ensureWranglerToolchain,
  wranglerToolchainDescriptor,
} from "../src/local/wrangler-toolchain.mjs";
import { wranglerToolchainMarkerMatches } from "../src/local/wrangler-toolchain-verification.mjs";
import { validateInstalledWranglerToolchainTree } from "../src/local/wrangler-toolchain-installed-tree.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-wrangler-toolchain-test-"));
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
try {
  const npmCli = join(root, "npm-cli.js");
  writeFileSync(npmCli, "// synthetic npm CLI\n", { mode: 0o644 });
  assert.equal(resolveNpmCli({ npmCli }), realpathSync(npmCli));

  const nodeRoot = join(root, "node-dist");
  const nodeExecutable = join(nodeRoot, "bin", process.platform === "win32" ? "node.exe" : "node");
  const nodeNpmCli = join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const lifecycleNpmCli = join(root, "lifecycle-npm-cli.js");
  mkdirSync(join(nodeRoot, "bin"), { recursive: true });
  mkdirSync(join(nodeRoot, "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(nodeExecutable, "synthetic Node executable\n", { mode: 0o755 });
  writeFileSync(nodeNpmCli, "// node-linked synthetic npm CLI\n", { mode: 0o644 });
  writeFileSync(lifecycleNpmCli, "// lifecycle synthetic npm CLI\n", { mode: 0o644 });
  assert.equal(resolveNpmCli({
    nodeExecutable,
    env: { npm_execpath: lifecycleNpmCli },
    allowLifecycleNpmCli: false,
    allowFallbackLocations: false,
  }), realpathSync(nodeNpmCli), "restricted npm resolution trusted lifecycle npm_execpath instead of the running Node installation");
  assert.throws(() => resolveNpmCli({
    nodeExecutable: join(root, "missing-node", "bin", "node"),
    env: { npm_execpath: lifecycleNpmCli },
    allowLifecycleNpmCli: false,
    allowFallbackLocations: false,
  }), /npm 12 CLI could not be located/, "restricted npm resolution fell back outside the running Node installation");
  if (process.platform !== "win32") {
    const prefix = join(root, "package-manager-prefix");
    const cellarNode = join(prefix, "Cellar", "node", "26.0.0", "bin", "node");
    const prefixNpmCli = join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(prefix, "Cellar", "node", "26.0.0", "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(cellarNode, "synthetic Homebrew Node executable\n", { mode: 0o755 });
    writeFileSync(prefixNpmCli, "// synthetic prefix npm CLI\n", { mode: 0o644 });
    assert.equal(resolveNpmCli({ nodeExecutable: cellarNode, allowLifecycleNpmCli: false, allowFallbackLocations: false }), realpathSync(prefixNpmCli),
      "restricted npm resolution missed the package-manager prefix associated with a Cellar Node runtime");
  }

  let nowMs = Date.parse("2026-08-05T07:00:00.000Z");
  const stateRoot = toolchainState(root, "state");
  const controlRoot = join(root, "control");
  const fake = createFakeNpmRunner();
  const options = {
    packageRoot,
    stateRoot,
    controlRoot,
    npmCli,
    runCommand: fake.run,
    now: () => nowMs,
    auditMaxAgeMs: 60_000,
  };

  const [first, second] = await Promise.all([
    ensureWranglerToolchain(options),
    ensureWranglerToolchain(options),
  ]);
  assert.equal(first, second);
  assert.equal(fake.count("ci"), 1, "concurrent toolchain initialization installed more than once");
  assert.equal(fake.count("audit"), 1, "initial toolchain audit did not run exactly once");
  assert.equal(fake.count("signatures"), 1, "initial registry signature verification did not run exactly once");
  const firstDescriptor = wranglerToolchainDescriptor({ packageRoot, stateRoot });
  const firstMarker = JSON.parse(readFileSync(join(first, ".machine-bridge-mcp-toolchain.json"), "utf8"));
  assert.equal(wranglerToolchainMarkerMatches(firstMarker, firstDescriptor), true);
  assert.equal(wranglerToolchainMarkerMatches({ ...firstMarker, audited_at: [firstMarker.audited_at] }, firstDescriptor), false,
    "coerced audited timestamp bypassed private toolchain marker validation");
  assert.throws(() => validateInstalledWranglerToolchainTree({
    problems: [],
    dependencies: {
      cf: { version: "1.0.0-beta.13" },
      wrangler: { version: "4.149.0", dependencies: { malformed: [{ dependencies: { sharp: { version: "0.35.4" } } }] } },
      undici: { version: "7.29.1" },
      sharp: { version: "0.35.5" },
      esbuild: { version: "0.28.2" },
      workerd: { version: "1.20261006.1" },
    },
  }, {
    cf: "1.0.0-beta.13", wrangler: "4.149.0", undici: "7.29.1", sharp: "0.35.5",
    esbuild: "0.28.2", workerd: "1.20261006.1",
  }),
  /invalid dependency node/,
  "malformed nested dependency node hid an unverified dependency subtree behind a patched Sharp sibling");

  const broadDependencies = Object.fromEntries(Object.entries(firstDescriptor.versions).map(([name, version]) => [name, { version }]));
  for (let index = Object.keys(broadDependencies).length; index < 20_000; index += 1) broadDependencies["fixture-" + index] = {};
  assert.doesNotThrow(() => validateInstalledWranglerToolchainTree({ dependencies: broadDependencies }, firstDescriptor.versions));
  let overflowReads = 0;
  Object.defineProperty(broadDependencies, "overflow", {
    enumerable: true, get() { overflowReads += 1; throw new Error("Unbounded dependency access"); },
  });
  assert.throws(() => validateInstalledWranglerToolchainTree({ dependencies: broadDependencies }, firstDescriptor.versions),
    /node limit/, "dependency traversal materialized an over-budget node");
  assert.equal(overflowReads, 0, "dependency traversal read an over-budget node before admission");
  const privateVersion = "SYNTHETIC_PRIVATE_VERSION_SENTINEL";
  assert.throws(() => validateInstalledWranglerToolchainTree({
    dependencies: { undici: { version: privateVersion } },
  }, firstDescriptor.versions), error => /pinned version/.test(error.message) && !error.message.includes(privateVersion),
  "unverified npm dependency text leaked through an integrity error");

  const callsBeforeMaintenance = fake.total();
  await withForeignMaintenanceLock(stateRoot, async () => {
    await assert.rejects(ensureWranglerToolchain(options), /state maintenance is active in another process/);
  });
  assert.equal(fake.total(), callsBeforeMaintenance, "toolchain work began after foreign state maintenance acquired exclusive ownership");

  await ensureWranglerToolchain(options);
  assert.equal(fake.count("ci"), 1, "fresh verified toolchain was reinstalled");
  assert.equal(fake.count("audit"), 1, "fresh verified toolchain was re-audited before expiry");
  const timeout = Object.assign(new Error("synthetic npm verification timeout"), { code: "ETIMEDOUT" });
  await assert.rejects(
    ensureWranglerToolchain({
      ...options,
      runCommand: async (command, args, runOptions) => {
        if (args[1] === "--version") throw timeout;
        return fake.run(command, args, runOptions);
      },
    }),
    error => error === timeout,
  );
  assert.equal(fake.count("ci"), 1, "operational Wrangler verification failure triggered destructive reconstruction");

  nowMs += 60_001;
  await ensureWranglerToolchain(options);
  assert.equal(fake.count("ci"), 1, "expired audit marker caused an unnecessary reinstall");
  assert.equal(fake.count("audit"), 2, "expired audit marker did not refresh the online audit");
  assert.equal(fake.count("signatures"), 2, "expired audit marker did not refresh registry signatures");

  nowMs -= 10 * 60_000;
  await ensureWranglerToolchain(options);
  assert.equal(fake.count("audit"), 3, "future-dated audit marker bypassed clock-skew validation");
  assert.equal(fake.count("signatures"), 3, "future-dated audit marker bypassed signature refresh");
  nowMs += 10 * 60_000;

  nowMs += 60_001;
  const cleanAudit = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const vulnerabilities of [
    ...[null, false, "", [], "0"].map(total => ({ ...cleanAudit, total })),
    { ...cleanAudit, high: 1 }, { ...cleanAudit, high: "0" },
  ]) {
    await assert.rejects(ensureWranglerToolchain({
      ...options,
      runCommand: async (command, args, runOptions) => args[1] === "audit" && args[2] !== "signatures"
        ? result(0, JSON.stringify({ metadata: { vulnerabilities } }))
        : fake.run(command, args, runOptions),
    }), /npm audit (metadata is incomplete|total is inconsistent)/);
  }
  assert.equal(fake.count("signatures"), 3, "malformed audit evidence reached signature verification");
  assert.equal(fake.count("ci"), 1, "malformed audit evidence triggered destructive reconstruction");
  assert(fake.launcherBins().every(bin => !existsSync(bin)), "settled toolchain operation retained a private npm launcher");

  const descriptor = wranglerToolchainDescriptor({ packageRoot, stateRoot });
  writeFileSync(join(descriptor.root, "package-lock.json"), "{}\n", "utf8");
  await ensureWranglerToolchain(options);
  assert.equal(fake.count("ci"), 2, "tampered toolchain lockfile did not trigger a clean reinstall");

  const vulnerableState = toolchainState(root, "vulnerable-state");
  const vulnerable = createFakeNpmRunner({ undici: "7.28.0" });
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: vulnerableState,
      controlRoot,
      npmCli,
      runCommand: vulnerable.run,
      now: () => nowMs,
    }),
    /undici version does not match the pinned version/,
  );

  const vulnerableSharp = createFakeNpmRunner({ sharp: "0.35.4" });
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: toolchainState(root, "vulnerable-sharp-state"),
      controlRoot,
      npmCli,
      runCommand: vulnerableSharp.run,
      now: () => nowMs,
    }),
    /sharp version does not match the pinned version/,
    "vulnerable Sharp installation passed the private toolchain integrity check",
  );

  const wrongWorkerd = createFakeNpmRunner({ workerd: "1.20260925.1" });
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: toolchainState(root, "wrong-workerd-state"),
      controlRoot,
      npmCli,
      runCommand: wrongWorkerd.run,
      now: () => nowMs,
    }),
    /workerd version does not match the pinned version/,
    "unexpected Workerd installation passed the private toolchain integrity check",
  );

  for (const [name, settings, message] of [
    ["coerced-sharp", { sharp: ["0.35.5"] }, /sharp version must be a string/],
    ["invalid-problems", { lsProblems: "invalid dependency edges" }, /dependency tree contains invalid edges/],
    ["invalid-npm", { npmVersion: "not-a-version" }, /valid npm 12 or newer version/],
    ["invalid-npm-hex", { npmVersion: "0x0c.0.2" }, /valid npm 12 or newer version/],
    ["invalid-npm-overflow", { npmVersion: "99999999999999999999.0.0" }, /valid npm 12 or newer version/],
  ]) {
    await assert.rejects(
      ensureWranglerToolchain({
        packageRoot,
        stateRoot: toolchainState(root, name),
        controlRoot,
        npmCli,
        runCommand: createFakeNpmRunner(settings).run,
        now: () => nowMs,
      }),
      message,
      `invalid private toolchain evidence passed validation: ${name}`,
    );
  }
  const leakedNpmOutput = "SYNTHETIC_PRIVATE_LOG_OUTPUT_SENTINEL";
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: toolchainState(root, "invalid-npm-output"),
      controlRoot,
      npmCli,
      runCommand: createFakeNpmRunner({ invalidLsOutput: leakedNpmOutput }).run,
      now: () => nowMs,
    }),
    (error) => /returned invalid JSON/.test(error.message) && !error.message.includes(leakedNpmOutput),
    "invalid npm JSON reflected private command output in a toolchain error",
  );

  const invalidTreeState = toolchainState(root, "invalid-tree-state");
  const invalidTree = createFakeNpmRunner();
  await ensureWranglerToolchain({
    packageRoot,
    stateRoot: invalidTreeState,
    controlRoot,
    npmCli,
    runCommand: invalidTree.run,
    now: () => nowMs,
  });
  const repairRunner = createFakeNpmRunner();
  let invalidLsPending = true;
  await ensureWranglerToolchain({
    packageRoot,
    stateRoot: invalidTreeState,
    controlRoot,
    npmCli,
    runCommand: async (command, args, runOptions) => {
      if (invalidLsPending && args[1] === "ls") {
        invalidLsPending = false;
        return result(1, JSON.stringify({ problems: ["invalid: wrangler@0.0.0"], dependencies: {} }));
      }
      return repairRunner.run(command, args, runOptions);
    },
    now: () => nowMs,
  });
  assert.equal(repairRunner.count("ci"), 1, "nonzero npm ls dependency problems did not trigger a clean reinstall");

  const auditedFailure = createFakeNpmRunner({ auditTotal: 1, auditHigh: 1 });
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: toolchainState(root, "audit-failure-state"),
      controlRoot,
      npmCli,
      runCommand: auditedFailure.run,
      now: () => nowMs,
    }),
    /dependency audit failed.*high=1/,
  );

  const cfFake = createFakeNpmRunner();
  const cfOptions = { ...options, stateRoot: toolchainState(root, "cf-state"), runCommand: cfFake.run };
  const [cfFirst, cfSecond] = await Promise.all([ensureCloudflareToolchain(cfOptions), ensureCloudflareToolchain(cfOptions)]);
  assert.equal(cfFirst, cfSecond);
  assert.equal(cfFake.count("ci"), 1, "concurrent cf initialization installed more than once");
  assert.equal(cfFake.count("signatures"), 1, "cf execution was permitted before signature verification");
  const cfBundle = join(cfFirst, "node_modules", "cf", CF_NETWORK_ARTIFACT.bundle);
  writeFileSync(cfBundle, "tampered cf bundle");
  await assert.rejects(ensureCloudflareToolchain(cfOptions), /pinned upstream artifact/);
  assert.equal(cfFake.count("ci"), 1, "unknown cf bytes triggered destructive reconstruction");
  console.log("Cloudflare private toolchain lifecycle and tamper test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function toolchainState(root, name) {
  const stateRoot = join(root, name);
  mkdirSync(stateRoot, { recursive: true });
  return stateRoot;
}

async function withForeignMaintenanceLock(stateRoot, callback) {
  const stateModuleUrl = new URL("../src/local/state.mjs", import.meta.url).href;
  const script = `import { acquireMaintenanceLock } from ${JSON.stringify(stateModuleUrl)};\n`
    + `const lock=acquireMaintenanceLock(process.argv[1],{operation:"wrangler-test"});\n`
    + `if(!lock.acquired)throw new Error("maintenance lock not acquired");\n`
    + `process.stdout.write("ready\\n");\n`
    + `process.on("SIGTERM",()=>{try{lock.release()}catch{}process.exit(0)});\n`
    + `setInterval(()=>{},1000);\n`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, stateRoot], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
  await waitForFixtureReady(child, { label: "foreign maintenance" });
  try { return await callback(); }
  finally { await stopFixtureChild(child); }
}

function createFakeNpmRunner(options = {}) {
  const calls = [];
  const launcherBins = new Set();
  const versions = {
    cf: options.cf || "1.0.0-beta.13",
    wrangler: options.wrangler || "4.149.0",
    undici: options.undici || "7.29.1",
    sharp: options.sharp || "0.35.5",
    esbuild: options.esbuild || "0.28.2",
    workerd: options.workerd || "1.20261006.1",
  };
  return {
    count(kind) { return calls.filter((value) => value === kind).length; },
    total() { return calls.length; },
    launcherBins() { return [...launcherBins]; },
    async run(_command, args, runOptions) {
      const bin = runOptions.env.PATH.split(delimiter)[0];
      launcherBins.add(bin);
      assert.equal(Object.keys(runOptions.env).filter(key => /^path$/i.test(key)).length, 1);
      assert.match(bin, /npm-bin-/);
      const launcher = readFileSync(join(bin, process.platform === "win32" ? "npm.cmd" : "npm"), "utf8");
      assert(launcher.includes(args[0]) && launcher.includes(process.execPath), "toolchain lifecycle npm launcher lost its explicit executable pair");
      const npmArgs = args.slice(1);
      if (npmArgs[0] === "--version") {
        calls.push("version");
        return result(0, `${options.npmVersion || "12.0.2"}\n`);
      }
      if (npmArgs[0] === "ci") {
        calls.push("ci");
        await delay(30);
        for (const [name, version] of Object.entries(versions)) {
          const directory = join(runOptions.cwd, "node_modules", name);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
          if (name === "cf") {
            const upstreamRoot = dirname(createRequire(import.meta.url).resolve("cf/package.json"));
            const bundle = join(directory, CF_NETWORK_ARTIFACT.bundle);
            mkdirSync(dirname(bundle), { recursive: true });
            writeFileSync(bundle, readFileSync(join(upstreamRoot, CF_NETWORK_ARTIFACT.bundle)), { mode: 0o600 });
          }
        }
        return result(0, "installed\n");
      }
      if (npmArgs[0] === "ls") {
        calls.push("ls");
        if (options.invalidLsOutput) return result(1, "{", options.invalidLsOutput);
        return result(Number(options.lsCode || 0), JSON.stringify({
          ...(options.lsProblems ? { problems: options.lsProblems } : {}),
          dependencies: {
            cf: { version: versions.cf },
            esbuild: { version: versions.esbuild },
            workerd: { version: versions.workerd },
            wrangler: {
              version: versions.wrangler,
              dependencies: {
                miniflare: {
                  version: "5.20261006.1-alpha",
                  dependencies: {
                    undici: { version: versions.undici },
                    sharp: { version: versions.sharp },
                  },
                },
              },
            },
          },
        }));
      }
      if (npmArgs[0] === "audit" && npmArgs[1] === "signatures") {
        calls.push("signatures");
        return result(0, "verified\n");
      }
      if (npmArgs[0] === "audit") {
        calls.push("audit");
        const total = Number(options.auditTotal || 0);
        return result(total ? 1 : 0, JSON.stringify({
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 0,
              moderate: 0,
              high: Number(options.auditHigh || 0),
              critical: 0,
              total,
            },
          },
        }));
      }
      throw new Error(`unexpected synthetic npm command: ${npmArgs.join(" ")}`);
    },
  };
}

function result(code, stdout = "", stderr = "") {
  return { code, stdout, stderr, stdout_truncated_bytes: 0, stderr_truncated_bytes: 0 };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}
