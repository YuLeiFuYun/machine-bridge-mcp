import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "mbm-release-impact-test-"));
try {
  mkdirSync(join(temp, "scripts"), { recursive: true });
  mkdirSync(join(temp, "src", "local"), { recursive: true });
  cpSync(join(root, "scripts", "release-impact-check.mjs"), join(temp, "scripts", "release-impact-check.mjs"));
  cpSync(join(root, "scripts", "release-channel.mjs"), join(temp, "scripts", "release-channel.mjs"));
  for (const name of ["trusted-git-executable.mjs", "trusted-executable.mjs", "errors.mjs"]) {
    cpSync(join(root, "src", "local", name), join(temp, "src", "local", name));
  }
  writeJson(join(temp, "package.json"), { name: "release-impact-fixture", version: "1.0.0", files: ["README.md", "scripts"] });
  writeFileSync(join(temp, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- Initial.\n");
  writeFileSync(join(temp, "README.md"), "initial\n");
  git(["init", "-q"]);
  git(["config", "user.name", "Release Test"]);
  git(["config", "user.email", "release-test@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  git(["tag", "v1.0.0"]);

  expectStatus(0, "clean tagged repository should pass");
  mkdirSync(join(temp, ".github", "workflows"), { recursive: true });
  writeFileSync(join(temp, ".github", "workflows", "ci.yml"), "name: CI\n");
  expectStatus(0, "repository-only GitHub workflow change should not require an npm version bump");
  rmSync(join(temp, ".github"), { recursive: true, force: true });

  writeFileSync(join(temp, ".gitignore"), "scratch/\n");
  expectStatus(0, "repository-only ignore change should not require an npm version bump");
  rmSync(join(temp, ".gitignore"), { force: true });

  writeFileSync(join(temp, "README.md"), "changed\n");
  expectStatus(1, "packaged documentation change without version bump should fail");

  writeJson(join(temp, "package.json"), { name: "release-impact-fixture", version: "1.0.1", files: ["README.md", "scripts"] });
  expectStatus(1, "version bump without changelog should fail");

  writeFileSync(join(temp, "CHANGELOG.md"), "# Changelog\n\n## 1.0.1 - 2026-01-02\n\n- Changed.\n\n## 1.0.0 - 2026-01-01\n\n- Initial.\n");
  expectStatus(0, "version bump with changelog should pass");

  console.log("release impact gate test ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function expectStatus(expected, message) {
  const result = spawnSync(process.execPath, [join(temp, "scripts", "release-impact-check.mjs")], {
    cwd: temp,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (`${result.stdout}${result.stderr}`.includes("ERR_MODULE_NOT_FOUND")) {
    throw new Error(`${message}; release-impact fixture failed before the gate ran: ${result.stderr || result.stdout}`);
  }
  if (result.status !== expected) {
    throw new Error(`${message}; expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  }
}

function git(args) {
  const result = spawnSync("git", args, { cwd: temp, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
