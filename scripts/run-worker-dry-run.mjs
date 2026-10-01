import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withCfProject } from "../src/local/cf-project.mjs";
import { workerDeploymentSourceSnapshot } from "../src/local/worker-deployment-fingerprint.mjs";
import { runCf } from "../src/local/shell.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function runWorkerDryRun(options = {}) {
  const sourceRoot = options.packageRoot || root;
  const snapshot = workerDeploymentSourceSnapshot(sourceRoot);
  const runCfFn = options.runCf || runCf;
  const environment = { ...(options.env || process.env), CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000" };
  return (options.withCfProject || withCfProject)(snapshot, "machine-bridge-mcp",
    project => runCfFn(["deploy", "--prebuilt", "--dry-run"], {
      ...project, packageRoot: sourceRoot, stateRoot: options.stateRoot, hardTimeout: true, timeoutMs: options.timeoutMs ?? 120_000,
    }), { packageRoot: sourceRoot, stateRoot: options.stateRoot, runCf: runCfFn, env: environment });
}
if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await runWorkerDryRun();
