import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NPM_VERSION = "12.0.1";
const NPM_TARBALL_URL = "https://registry.npmjs.org/npm/-/npm-12.0.1.tgz";
const NPM_TARBALL_INTEGRITY = "sha512-L5T9i/YAQWQWqTS/xZxJkei/9zcu99hCeE4qi41IyBVV7mRQad3qc2JfuOktwmH+qwGI/V2rbCL+/UYxb1+RQA==";
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;

const githubPath = process.env.GITHUB_PATH;
if (!githubPath) throw new Error("GITHUB_PATH is required; this bootstrap is intended for GitHub Actions");

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mbm-npm-bootstrap-"));
try {
  const archive = join(root, `npm-${NPM_VERSION}.tgz`);
  const extracted = join(root, "extracted");
  const bin = join(root, "bin");
  mkdirSync(extracted, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const response = await fetch(NPM_TARBALL_URL, { redirect: "error" });
  if (!response.ok) throw new Error(`failed to download pinned npm tarball: HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TARBALL_BYTES) throw new Error("pinned npm tarball exceeds 20 MiB");
  const bytes = await readBoundedBody(response, MAX_TARBALL_BYTES);
  verifyIntegrity(bytes, NPM_TARBALL_INTEGRITY);
  writeFileSync(archive, bytes, { mode: 0o600 });

  run("tar", ["-xzf", archive, "-C", extracted]);
  const cli = join(extracted, "package", "bin", "npm-cli.js");
  const version = run(process.execPath, [cli, "--version"], { capture: true }).trim();
  if (version !== NPM_VERSION) throw new Error(`pinned npm tarball reported ${version}, expected ${NPM_VERSION}`);

  const posixWrapper = join(bin, "npm");
  writeFileSync(posixWrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o755 });
  chmodSync(posixWrapper, 0o755);
  writeFileSync(join(bin, "npm.cmd"), `@echo off\r\n"${cmdQuote(process.execPath)}" "${cmdQuote(cli)}" %*\r\n`);
  writeFileSync(githubPath, `${bin}\n`, { flag: "a" });
  console.log(`Prepared integrity-verified npm ${NPM_VERSION} at ${bin}`);
} catch (error) {
  rmSync(root, { recursive: true, force: true });
  throw error;
}


async function readBoundedBody(response, maximumBytes) {
  if (!response.body) throw new Error("pinned npm tarball response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("pinned npm tarball exceeds 20 MiB");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function verifyIntegrity(bytes, integrity) {
  const match = /^sha512-(.+)$/.exec(integrity);
  if (!match) throw new Error("pinned npm integrity must be SHA-512 SRI");
  const actual = createHash("sha512").update(bytes).digest();
  const expected = Buffer.from(match[1], "base64");
  if (actual.length !== expected.length || !actual.equals(expected)) throw new Error("pinned npm tarball failed SHA-512 verification");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? String(result.stdout || "") : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(value) {
  const text = String(value);
  if (/[\0\r\n"%&|<>^!]/.test(text)) throw new Error("Windows wrapper path contains an unsupported character");
  return text;
}
