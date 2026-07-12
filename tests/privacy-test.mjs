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
  git(["config", "user.name", "Privacy Test"]);
  git(["config", "user.email", "developer@example.com"]);

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

  const safeNpmrc = join(temp, ".npmrc");
  writeFileSync(safeNpmrc, "engine-strict=true\n");
  const safeNpmrcResult = runCheck();
  assert(safeNpmrcResult.status === 0, `safe tracked .npmrc was rejected: ${safeNpmrcResult.stderr}`);
  const npmToken = ["npm", "A".repeat(36)].join("_");
  const npmAuthKey = ["_auth", "Token"].join("");
  writeFileSync(safeNpmrc, `//registry.npmjs.org/:${npmAuthKey}=${npmToken}\n`);
  const npmrcAuth = runCheck();
  assert(npmrcAuth.status === 1 && npmrcAuth.stderr.includes("tracked .npmrc contains authentication"), "privacy checker missed npm authentication configuration");
  assert(!`${npmrcAuth.stdout}${npmrcAuth.stderr}`.includes(npmToken), "privacy checker echoed an npm token");
  rmSync(safeNpmrc, { force: true });

  assertSensitiveContent("npm-token.txt", npmToken, "npm access token");
  assertSensitiveContent("slack-token.txt", ["xoxb", "1234567890", "ABCDEFGHIJK"].join("-"), "Slack access token");
  assertSensitiveContent("google-key.txt", ["AI", "za", "A".repeat(35)].join(""), "Google API key");
  assertSensitiveContent("jwt.txt", ["eyJ" + "A".repeat(12), "B".repeat(12), "C".repeat(12)].join("."), "JWT-like bearer token");
  assertSensitiveContent("private-key.txt", ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), "private key material");
  assertSensitiveContent("credential-url.txt", ["https://operator", ["private-value@host", "actual-domain", "test/path"].join(".")].join(":"), "URL with embedded credentials");

  const reservedCredentialUrl = join(temp, "reserved-credential-url.txt");
  writeFileSync(reservedCredentialUrl, "https://synthetic:fixture@example.com/path\n");
  const reservedCredentialResult = runCheck();
  assert(reservedCredentialResult.status === 0, `reserved example credential URL was rejected: ${reservedCredentialResult.stderr}`);
  rmSync(reservedCredentialUrl, { force: true });
  assertSensitiveContent("email.txt", ["person", "actual-domain.test"].join("@"), "non-example email address");

  const sensitivePath = join(temp, [".env", "production"].join("."));
  writeFileSync(sensitivePath, "neutral=true\n");
  const sensitivePathResult = runCheck();
  assert(sensitivePathResult.status === 1 && sensitivePathResult.stderr.includes("credential- or private-data-shaped publication filename"), "privacy checker missed a credential-shaped filename");
  rmSync(sensitivePath, { force: true });

  writeFileSync(join(temp, "README.md"), "synthetic example only\n");
  const clean = runCheck();
  assert(clean.status === 0, `clean privacy fixture failed: ${clean.stderr}`);

  git(["add", "scripts/privacy-check.mjs", "README.md"]);
  const publicAutomationEmail = ["support", "github.com"].join("@");
  git(["commit", "-q", "-m", "safe baseline", "-m", `Signed-off-by: dependabot[bot] <${publicAutomationEmail}>`]);
  const safeHistory = runCheck({ args: ["--history"] });
  assert(safeHistory.status === 0, `public Dependabot trailer was rejected by history scanning: ${safeHistory.stderr}`);
  const historicalToken = ["npm", "H".repeat(36)].join("_");
  const historicalFile = join(temp, "historical-token.txt");
  writeFileSync(historicalFile, `${historicalToken}\n`);
  git(["add", "historical-token.txt"]);
  git(["commit", "-q", "-m", "historical fixture"]);
  rmSync(historicalFile, { force: true });
  git(["add", "-u"]);
  git(["commit", "-q", "-m", "remove historical fixture"]);
  const cleanCurrentAfterDeletion = runCheck();
  assert(cleanCurrentAfterDeletion.status === 0, `deleted historical fixture remained in the current publication surface: ${cleanCurrentAfterDeletion.stderr}`);
  const historicalResult = runCheck({ args: ["--history"] });
  assert(historicalResult.status === 1 && historicalResult.stderr.includes("npm access token"), "privacy history scan missed a deleted reachable credential blob");
  assert(!`${historicalResult.stdout}${historicalResult.stderr}`.includes(historicalToken), "privacy history scan echoed a historical credential");

  rmSync(join(temp, ".privacy-denylist"), { force: true });
  mkdirSync(join(temp, ".privacy-denylist"));
  const unreadableDenylist = runCheck();
  assert(unreadableDenylist.status !== 0 && unreadableDenylist.stderr.includes("local privacy denylist exists but could not be read"), "privacy checker ignored an unreadable denylist");
  console.log("privacy gate test ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function assertSensitiveContent(name, value, rule) {
  const file = join(temp, name);
  writeFileSync(file, `${value}\n`);
  const result = runCheck();
  assert(result.status === 1 && result.stderr.includes(rule), `privacy checker missed ${rule}`);
  assert(!`${result.stdout}${result.stderr}`.includes(value), `privacy checker echoed ${rule}`);
  rmSync(file, { force: true });
}

function fsRead(path) { return readFileSync(path, "utf8"); }

function runCheck(options = {}) {
  return spawnSync(process.execPath, [join(temp, "scripts", "privacy-check.mjs"), ...(options.args || [])], {
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
