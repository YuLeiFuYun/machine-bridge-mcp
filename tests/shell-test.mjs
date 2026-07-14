import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wranglerCommand } from "../src/local/shell.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-wrangler-command-"));
try {
  const script = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  await mkdir(join(root, "node_modules", "wrangler", "bin"), { recursive: true });
  await writeFile(script, "process.exit(0);\n", "utf8");
  const node = resolve(root, "synthetic-node");
  const command = wranglerCommand({ packageRoot: root, node });
  if (command.cmd !== node) throw new Error("Wrangler command did not use the explicit Node executable");
  if (JSON.stringify(command.argsPrefix) !== JSON.stringify([script])) {
    throw new Error(`Wrangler command did not use the package JavaScript entrypoint: ${JSON.stringify(command)}`);
  }
  if (command.cmd.endsWith(".cmd") || command.argsPrefix.some((value) => value.endsWith(".cmd"))) {
    throw new Error("Wrangler command regressed to a Windows command-shell shim");
  }
  console.log("Wrangler executable boundary test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
