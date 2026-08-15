import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), "mbm-ci-bootstrap-test-"));
try {
  const fresh = join(sandbox, "fresh-checkout");
  mkdirSync(join(fresh, "scripts"), { recursive: true });
  mkdirSync(join(fresh, "src"), { recursive: true });
  cpSync(join(root, "scripts", "prepare-pinned-npm.mjs"), join(fresh, "scripts", "prepare-pinned-npm.mjs"));
  cpSync(join(root, "src", "local"), join(fresh, "src", "local"), { recursive: true });
  cpSync(join(root, "src", "shared"), join(fresh, "src", "shared"), { recursive: true });
  assert(!existsSync(join(fresh, "node_modules")), "fresh bootstrap fixture unexpectedly contains node_modules");

  const githubPath = join(sandbox, "github-path");
  const run = spawnSync(process.execPath, ["scripts/prepare-pinned-npm.mjs"], {
    cwd: fresh,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      GITHUB_PATH: githubPath,
      RUNNER_TEMP: sandbox,
      HTTPS_PROXY: "http://[::1",
      https_proxy: "",
      HTTP_PROXY: "",
      http_proxy: "",
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`;
  assert.notEqual(run.status, 0, "malformed proxy configuration unexpectedly completed the bootstrap");
  assert.match(output, /HTTP proxy configuration is not a valid URL/,
    "fresh bootstrap did not reach its standard-library proxy validation boundary");
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find package|node_modules/,
    "fresh bootstrap imported a package that is unavailable before npm ci");
  assert(!existsSync(join(fresh, "node_modules")), "bootstrap created a repository node_modules tree");
  console.log("fresh CI npm bootstrap test ok");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
