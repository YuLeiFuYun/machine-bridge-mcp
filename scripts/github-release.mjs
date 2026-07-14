#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runNetworkCommand } from "./network-retry.mjs";
import { requireSuccessfulWorkflowRun } from "./release-ci.mjs";
import { tagSyncError } from "./release-state.mjs";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

function fail(message) {
  console.error(`release error: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
      : "";
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}


function runNetwork(command, args, options = {}) {
  const result = runNetworkCommand(command, args, { cwd: root, env: process.env });
  if (!options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error && !options.allowFailure) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) failCommandResult(command, args, result);
  return result;
}

function outputNetwork(command, args, options = {}) {
  const result = runNetwork(command, args, { ...options, capture: true });
  return (result.stdout ?? "").trim();
}

function failCommandResult(command, args, result) {
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

function output(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  return (result.stdout ?? "").trim();
}

function packageMetadata() {
  const data = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof data.name !== "string" || typeof data.version !== "string") {
    fail("package.json must contain string name and version fields");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)) {
    fail(`unsupported package version: ${data.version}`);
  }
  return data;
}

function changelogBody(version) {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s+-[^\\n]*)?$`, "m");
  const match = heading.exec(changelog);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = changelog.slice(start).search(/^## /m);
  const body = changelog.slice(start, next < 0 ? undefined : start + next).trim();
  return body || null;
}

function ensureClean() {
  const status = output("git", ["status", "--porcelain"]);
  if (status) fail(`working tree is not clean:\n${status}`);
}

function fetchRemote() {
  runNetwork("git", ["fetch", "origin", "main", "--tags", "--prune"]);
}

function localTagCommit(tag) {
  const result = run("git", ["rev-list", "-n", "1", tag], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteTagCommit(tag) {
  const text = outputNetwork("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (!text) return null;
  const rows = text.split("\n").map((line) => line.trim().split(/\s+/));
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (peeled ?? direct)?.[0] ?? null;
}

function assertSuccessfulCi(head) {
  const required = [
    [".github/workflows/ci.yml", "CI"],
    [".github/workflows/codeql.yml", "CodeQL"],
    [".github/workflows/governance.yml", "Governance"],
    [".github/workflows/scorecard.yml", "OpenSSF Scorecard"],
  ];
  const verified = [];
  for (const [workflow, name] of required) {
    const text = outputNetwork("gh", [
      "run",
      "list",
      "--workflow",
      workflow,
      "--commit",
      head,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,headSha,event,createdAt,url",
    ]);
    let runs;
    try { runs = JSON.parse(text); }
    catch { fail(`GitHub Actions did not return valid JSON for ${name}`); }
    let run;
    try { run = requireSuccessfulWorkflowRun(runs, head, name); }
    catch (error) { fail(String(error?.message || error)); }
    console.log(`GitHub Actions ${name} succeeded for ${head} (run ${run.databaseId}).`);
    verified.push(run);
  }
  return verified;
}

function releaseInfo(tag) {
  const result = runNetwork(
    "gh",
    [
      "release",
      "view",
      tag,
      "--json",
      "tagName,name,targetCommitish,isDraft,isPrerelease,assets,url",
    ],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function assertCoreSync({ requireReleaseAsset }) {
  const pkg = packageMetadata();
  const tag = `v${pkg.version}`;
  const head = output("git", ["rev-parse", "HEAD"]);
  const originMain = output("git", ["rev-parse", "origin/main"]);
  if (head !== originMain) {
    fail(`HEAD ${head} does not match origin/main ${originMain}`);
  }
  assertSuccessfulCi(head);

  const localCommit = localTagCommit(tag);
  const localTagError = tagSyncError({ scope: "local", tag, head, commit: localCommit });
  if (localTagError) fail(localTagError);

  const remoteCommit = remoteTagCommit(tag);
  const remoteTagError = tagSyncError({ scope: "remote", tag, head, commit: remoteCommit });
  if (remoteTagError) fail(remoteTagError);

  const release = releaseInfo(tag);
  if (!release || release.isDraft || release.isPrerelease) {
    fail(`published GitHub Release ${tag} is missing or not final`);
  }

  if (requireReleaseAsset) {
    const expectedAsset = `${pkg.name}-${pkg.version}.tgz`;
    const names = new Set((release.assets ?? []).map((asset) => asset.name));
    if (!names.has(expectedAsset)) {
      fail(`GitHub Release ${tag} is missing ${expectedAsset}`);
    }
  }

  console.log(`GitHub source, tag, release, and package asset are in sync: ${tag}`);
}

function writeNotesFile(directory, version) {
  const body = changelogBody(version);
  if (!body) return null;
  const path = join(directory, `release-${version}.md`);
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return path;
}

function packReleaseAsset(directory, pkg) {
  const result = run(
    "npm",
    ["pack", "--silent", "--json", "--pack-destination", directory],
    { capture: true },
  );
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    fail("npm pack did not return valid JSON");
  }
  const record = normalizePackRecord(records, pkg.name);
  const filename = record?.filename;
  if (typeof filename !== "string") fail("npm pack did not report a filename");
  const path = join(directory, filename);
  const expected = `${pkg.name.replaceAll("/", "-").replace(/^@/, "")}-${pkg.version}.tgz`;
  if (filename !== expected) {
    fail(`unexpected npm package filename ${filename}; expected ${expected}`);
  }
  return path;
}

function normalizePackRecord(value, packageName) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (!value || typeof value !== "object") return null;
  if (value[packageName] && typeof value[packageName] === "object") return value[packageName];
  return Object.values(value).find((item) => item && typeof item === "object") ?? null;
}

function ensureRelease(tag, version, assetPath, latest) {
  const temp = dirname(assetPath);
  const notes = writeNotesFile(temp, version);
  const existing = releaseInfo(tag);
  const title = `machine-bridge-mcp ${tag}`;

  if (!existing) {
    const args = [
      "release",
      "create",
      tag,
      assetPath,
      "--verify-tag",
      "--title",
      title,
      latest ? "--latest" : "--latest=false",
    ];
    if (notes) args.push("--notes-file", notes);
    else args.push("--generate-notes");
    const created = runNetwork("gh", args, { allowFailure: true });
    if (created.status !== 0 && !releaseInfo(tag)) failCommandResult("gh", args, created);
  } else {
    runNetwork("gh", [
      "release",
      "edit",
      tag,
      "--title",
      title,
      latest ? "--latest" : "--latest=false",
      ...(notes ? ["--notes-file", notes] : []),
    ]);
    runNetwork("gh", ["release", "upload", tag, assetPath, "--clobber"]);
  }
}

function publishCurrent() {
  ensureClean();
  fetchRemote();

  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "main") fail(`release must run from main, not ${branch || "detached HEAD"}`);

  const pkg = packageMetadata();
  const tag = `v${pkg.version}`;
  if (!changelogBody(pkg.version)) {
    fail(`CHANGELOG.md has no section for ${pkg.version}`);
  }

  run("npm", ["run", "check"]);
  run("npm", ["run", "version:check"]);
  ensureClean();

  const head = output("git", ["rev-parse", "HEAD"]);
  const originMain = output("git", ["rev-parse", "origin/main"]);
  if (head !== originMain) {
    const ancestor = run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], {
      capture: true,
      allowFailure: true,
    });
    if (ancestor.status !== 0) {
      fail("origin/main is not an ancestor of HEAD; refusing a non-fast-forward release");
    }
    runNetwork("git", ["push", "origin", "HEAD:main"]);
  }
  assertSuccessfulCi(head);

  const existingLocal = localTagCommit(tag);
  if (existingLocal && existingLocal !== head) {
    fail(`local ${tag} points to ${existingLocal}, not ${head}`);
  }
  if (!existingLocal) {
    run("git", ["tag", "-a", tag, "-m", `Release ${pkg.version}`]);
  }

  const existingRemote = remoteTagCommit(tag);
  if (existingRemote && existingRemote !== head) {
    fail(`remote ${tag} points to ${existingRemote}, not ${head}`);
  }
  if (!existingRemote) {
    runNetwork("git", ["push", "origin", tag]);
  }

  const temp = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-release-"));
  try {
    const assetPath = packReleaseAsset(temp, pkg);
    ensureRelease(tag, pkg.version, assetPath, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  fetchRemote();
  assertCoreSync({ requireReleaseAsset: true });
}

function backfillMissingReleases() {
  ensureClean();
  fetchRemote();

  const tags = output("git", ["tag", "--sort=version:refname"])
    .split("\n")
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const releases = JSON.parse(outputNetwork("gh", [
    "release",
    "list",
    "--limit",
    "1000",
    "--json",
    "tagName",
  ]));
  const existing = new Set(releases.map((release) => release.tagName));
  const missing = tags.filter((tag) => !existing.has(tag));

  if (missing.length === 0) {
    console.log("No GitHub Releases are missing.");
    return;
  }

  const temp = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-backfill-"));
  try {
    for (const tag of missing) {
      if (!remoteTagCommit(tag)) fail(`remote tag ${tag} is missing`);
      const version = tag.slice(1);
      const notes = writeNotesFile(temp, version);
      const args = [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--title",
        `machine-bridge-mcp ${tag}`,
        "--latest=false",
      ];
      if (notes) args.push("--notes-file", notes);
      else args.push("--generate-notes");
      const created = runNetwork("gh", args, { allowFailure: true });
      if (created.status !== 0 && !releaseInfo(tag)) failCommandResult("gh", args, created);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  console.log(`Backfilled ${missing.length} GitHub Release(s): ${missing.join(", ")}`);
}

const mode = process.argv[2] ?? "--check";
if (mode === "--check") {
  ensureClean();
  fetchRemote();
  assertCoreSync({ requireReleaseAsset: true });
} else if (mode === "--publish") {
  publishCurrent();
} else if (mode === "--backfill") {
  backfillMissingReleases();
} else {
  fail("usage: node scripts/github-release.mjs [--check|--publish|--backfill]");
}
