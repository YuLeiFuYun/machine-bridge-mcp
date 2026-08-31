import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executionEnv, wranglerCommand } from "../src/local/shell.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-wrangler-command-"));
try {
  const script = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  await mkdir(join(root, "node_modules", "wrangler", "bin"), { recursive: true });
  await writeFile(script, "process.exit(0);\n", "utf8");
  const node = resolve(root, "synthetic-node");
  const command = wranglerCommand({ packageRoot: root, node });
  if (command.cmd !== node) throw new Error("Wrangler command did not use the explicit Node executable");
  const canonicalScript = realpathSync(script);
  if (JSON.stringify(command.argsPrefix) !== JSON.stringify([canonicalScript])) {
    throw new Error(`Wrangler command did not use the canonical package JavaScript entrypoint: ${JSON.stringify(command)}`);
  }
  if (command.cmd.endsWith(".cmd") || command.argsPrefix.some((value) => value.endsWith(".cmd"))) {
    throw new Error("Wrangler command regressed to a Windows command-shell shim");
  }
  const previousPassEnv = process.env.MBM_PASS_ENV;
  const previousPrivateValue = process.env.MBM_SHELL_TEST_PRIVATE;
  try {
    process.env.MBM_PASS_ENV = "true";
    process.env.MBM_SHELL_TEST_PRIVATE = "must-not-be-inherited";
    const minimal = executionEnv(root, { runtimeDir: root });
    if (minimal.MBM_SHELL_TEST_PRIVATE !== undefined) {
      throw new Error("minimal execution environment was widened by an ambient process override");
    }
    if (minimal.HOME !== join(root, "home") || minimal.MBM_WORKSPACE !== root) {
      throw new Error("minimal execution environment lost its private runtime identity");
    }
    const full = executionEnv(root, { fullEnv: true, runtimeDir: root });
    if (full.MBM_SHELL_TEST_PRIVATE !== "must-not-be-inherited") {
      throw new Error("explicit full execution environment no longer inherits the parent environment");
    }
  } finally {
    if (previousPassEnv === undefined) delete process.env.MBM_PASS_ENV;
    else process.env.MBM_PASS_ENV = previousPassEnv;
    if (previousPrivateValue === undefined) delete process.env.MBM_SHELL_TEST_PRIVATE;
    else process.env.MBM_SHELL_TEST_PRIVATE = previousPrivateValue;
  }
  if (process.platform !== "win32") {
    const target = join(root, "real-wrangler.js");
    await writeFile(target, "process.exit(0);\n", "utf8");
    await rm(script);
    await symlink(target, script);
    expectThrow(() => wranglerCommand({ packageRoot: root, node }), "real regular file");
  }
  console.log("Wrangler executable boundary test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectThrow(callback, expected) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}
