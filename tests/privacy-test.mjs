import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "mbm-privacy-test-"));
const privateName = ["private", "alias+fixture"].join(".");
try {
  mkdirSync(join(temp, "scripts"), { recursive: true });
  cpSync(join(root, "scripts", "privacy-check.mjs"), join(temp, "scripts", "privacy-check.mjs"));
  writeFileSync(join(temp, ".privacy-denylist"), `${privateName}\n`, { mode: 0o600 });
  git(["init", "-q"]);

  const checkerPath = join(temp, "scripts", "privacy-check.mjs");
  const checkerSource = fsRead(checkerPath);
  writeFileSync(checkerPath, `${checkerSource}\n// ${privateName}\n`);
  const selfResult = runCheck();
  assert(selfResult.status === 1, "privacy checker skipped a denylisted value in its own source");
  assert(!`${selfResult.stdout}${selfResult.stderr}`.toLowerCase().includes(privateName), "privacy checker echoed a denylisted value from its own source");
  writeFileSync(checkerPath, checkerSource);

  const namedFile = join(temp, `${privateName}-notes.txt`);
  writeFileSync(namedFile, "neutral content\n");
  const namedResult = runCheck();
  assert(namedResult.status === 1, "privacy checker missed a denylisted file name");
  assert(!`${namedResult.stdout}${namedResult.stderr}`.toLowerCase().includes(privateName), "privacy checker echoed a denylisted value");
  rmSync(namedFile, { force: true });

  if (process.platform !== "win32") {
    const outside = join(temp, "outside.txt");
    writeFileSync(outside, "outside private content\n");
    const link = join(temp, "linked-fixture.txt");
    symlinkSync(outside, link);
    const linkResult = runCheck();
    assert(linkResult.status === 1 && linkResult.stderr.includes("symbolic link in publication surface"), "privacy checker followed or ignored a publication symlink");
    assert(!linkResult.stderr.includes("outside private content"), "privacy checker exposed a symlink target value");
    const fallbackLinkResult = runCheck({ withoutGit: true });
    assert(fallbackLinkResult.status === 1 && fallbackLinkResult.stderr.includes("symbolic link in publication surface"), "privacy checker fallback traversal missed a publication symlink");
    rmSync(link, { force: true });
    rmSync(outside, { force: true });
  }

  const binary = join(temp, "binary-fixture.bin");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const binaryResult = runCheck();
  assert(binaryResult.status === 1 && binaryResult.stderr.includes("binary file in publication surface"), "privacy checker silently skipped a binary publication file");
  rmSync(binary, { force: true });

  writeFileSync(join(temp, "README.md"), "synthetic example only\n");
  const clean = runCheck();
  assert(clean.status === 0, `clean privacy fixture failed: ${clean.stderr}`);
  console.log("privacy gate test ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function fsRead(path) { return readFileSync(path, "utf8"); }

function runCheck(options = {}) {
  return spawnSync(process.execPath, [join(temp, "scripts", "privacy-check.mjs")], {
    cwd: temp,
    encoding: "utf8",
    windowsHide: true,
    env: options.withoutGit ? { ...process.env, PATH: "" } : process.env,
  });
}

function git(args) {
  const result = spawnSync("git", args, { cwd: temp, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
