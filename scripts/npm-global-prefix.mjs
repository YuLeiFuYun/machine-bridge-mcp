import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { releaseCommandFailure } from "./release-diagnostic.mjs";

export function resolveNpmGlobalPrefix(npmCli, options = {}) {
  const cli = String(npmCli || "").trim();
  if (!isAbsolute(cli)) throw new TypeError("npm global prefix resolution requires an absolute npm CLI path");
  const cwd = resolve(String(options.cwd || process.cwd()));
  const run = options.run || spawnSync;
  const result = run(process.execPath, [cli, "prefix", "--global", "--json=false", "--parseable=false"], {
    cwd,
    encoding: "utf8",
    env: nestedNpmEnvironment(options.env || process.env),
    timeout: 30_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm global prefix resolution failed: ${releaseCommandFailure("npm", ["prefix"], result)}`);
  }
  const prefix = String(result.stdout || "").trim();
  if (!prefix || prefix.length > 32 * 1024 || /[\0\r\n]/.test(prefix) || !isAbsolute(prefix)) {
    throw new Error("npm global prefix output is invalid");
  }
  return resolve(prefix);
}
