import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureWranglerToolchain,
  resolveNpmCli,
  wranglerToolchainDescriptor,
} from "../src/local/wrangler-toolchain.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-wrangler-toolchain-test-"));
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
try {
  const npmCli = join(root, "npm-cli.js");
  writeFileSync(npmCli, "// synthetic npm CLI\n", { mode: 0o644 });
  assert.equal(resolveNpmCli({ npmCli }), realpathSync(npmCli));

  let nowMs = Date.parse("2026-08-05T07:00:00.000Z");
  const stateRoot = join(root, "state");
  const fake = createFakeNpmRunner();
  const options = {
    packageRoot,
    stateRoot,
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

  const vulnerableState = join(root, "vulnerable-state");
  const vulnerable = createFakeNpmRunner({ undici: "7.28.0" });
  await assert.rejects(
    ensureWranglerToolchain({
      packageRoot,
      stateRoot: vulnerableState,
      npmCli,
      runCommand: vulnerable.run,
      now: () => nowMs,
    }),
    /undici versions 7\.28\.0 do not match 7\.29\.0/,
  );

  const invalidTreeState = join(root, "invalid-tree-state");
  const invalidTree = createFakeNpmRunner();
  await ensureWranglerToolchain({
    packageRoot,
    stateRoot: invalidTreeState,
    npmCli,
    runCommand: invalidTree.run,
    now: () => nowMs,
  });
  const repairRunner = createFakeNpmRunner();
  let invalidLsPending = true;
  await ensureWranglerToolchain({
    packageRoot,
    stateRoot: invalidTreeState,
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
      stateRoot: join(root, "audit-failure-state"),
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

function createFakeNpmRunner(options = {}) {
  const calls = [];
  const versions = {
    wrangler: options.wrangler || "4.115.0",
    undici: options.undici || "7.29.0",
    sharp: options.sharp || "0.35.3",
  };
  return {
    count(kind) { return calls.filter((value) => value === kind).length; },
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
