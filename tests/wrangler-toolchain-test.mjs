import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "../src/local/npm-cli.mjs";
import {
  ensureWranglerToolchain,
  wranglerToolchainDescriptor,
} from "../src/local/wrangler-toolchain.mjs";

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
    /undici versions 7\.28\.0 do not match 7\.29\.0/,
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

  console.log("Wrangler private toolchain lifecycle test ok");
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
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? rejectPromise(error) : resolvePromise();
    };
    const timer = setTimeout(() => finish(new Error("foreign maintenance fixture did not become ready")), 10_000);
    child.once("error", finish);
    child.once("exit", (code) => finish(new Error(`foreign maintenance fixture exited early (${code})`)));
    child.stdout.once("data", (chunk) => finish(String(chunk).includes("ready") ? null : new Error("foreign maintenance fixture emitted an invalid readiness marker")));
  });
  try { return await callback(); }
  finally {
    const closed = new Promise((resolvePromise) => {
      child.once("close", resolvePromise);
    });
    child.kill("SIGTERM");
    await closed;
  }
}

function createFakeNpmRunner(options = {}) {
  const calls = [];
  const versions = {
    wrangler: options.wrangler || "4.127.0",
    undici: options.undici || "7.29.0",
    sharp: options.sharp || "0.35.3",
  };
  return {
    count(kind) { return calls.filter((value) => value === kind).length; },
    total() { return calls.length; },
    async run(_command, args, runOptions) {
      const npmArgs = args.slice(1);
      if (npmArgs[0] === "--version") {
        calls.push("version");
        return result(0, "12.0.2\n");
      }
      if (npmArgs[0] === "ci") {
        calls.push("ci");
        await delay(30);
        for (const [name, version] of Object.entries(versions)) {
          const directory = join(runOptions.cwd, "node_modules", name);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
        }
        return result(0, "installed\n");
      }
      if (npmArgs[0] === "ls") {
        calls.push("ls");
        return result(Number(options.lsCode || 0), JSON.stringify({
          ...(options.lsProblems ? { problems: options.lsProblems } : {}),
          dependencies: {
            wrangler: {
              version: versions.wrangler,
              dependencies: {
                miniflare: {
                  version: "4.20260722.1",
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
