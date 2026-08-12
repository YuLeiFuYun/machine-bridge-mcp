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
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { stageAcceptedCandidateTarball } from "./accepted-candidate-tarball.mjs";
import { createHardenedNpmSession } from "./hardened-npm-session.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { resolveTrustedGithubCli } from "../src/local/trusted-github-cli.mjs";
import { githubReleaseByTagEndpoint, waitForGithubReleaseAsset } from "./github-release-asset.mjs";
import { parseReleaseVersion, requiresSoakForStable } from "./release-channel.mjs";
import { verifyCurrentStableSoak } from "./release-soak.mjs";
import { assertOwnerTerminalPublication, withGithubPublicationLock } from "./release-publication-guard.mjs";
import { releaseCommandFailure, releaseDiagnostic, releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = resolveTrustedGitExecutable({ workspace: root });
const gh = resolveTrustedGithubCli({ workspace: root });
process.chdir(root);

function fail(message) {
  throw new Error(String(message || "release failed"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env || process.env,
    timeout: options.timeoutMs || 20 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });

  if ((result.error || result.status !== 0) && !options.allowFailure) {
    fail(releaseCommandFailure(command, args, options.capture ? result : { ...result, stdout: "", stderr: "" }));
  }
  return result;
}


function runNetwork(command, args, options = {}) {
  const result = runNetworkCommand(command, args, { cwd: root, env: process.env });
  if (!options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error && !options.allowFailure) fail(releaseCommandFailure(command, args, result));
  if (result.status !== 0 && !options.allowFailure) failCommandResult(command, args, result);
  return result;
}

function outputNetwork(command, args, options = {}) {
  const result = runNetwork(command, args, { ...options, capture: true });
  return (result.stdout ?? "").trim();
}

function failCommandResult(command, args, result) {
  fail(releaseCommandFailure(command, args, result));
}

function output(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  return (result.stdout ?? "").trim();
}


function runNpmScript(npmCli, task) {
  return run(process.execPath, [
    npmCli, "run", "--workspaces=false", "--global=false", "--ignore-scripts=false",
    "--if-present=false", "--prefix", root, task,
  ], { env: nestedNpmEnvironment(process.env) });
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
  const status = output(git, ["status", "--porcelain"]);
  if (status) fail(`working tree is not clean:\n${status}`);
}

function fetchRemote() {
  runNetwork(git, ["fetch", "origin", "main", "--tags", "--prune"]);
}

function localTagCommit(tag) {
  const result = run(git, ["rev-list", "-n", "1", tag], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteTagCommit(tag) {
  const text = outputNetwork(git, [
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
    [".github/workflows/workflow-policy.yml", "Workflow Policy Gate"],
  ];
  const verified = [];
  for (const [workflow, name] of required) {
    const text = outputNetwork(gh, [
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
  const args = ["api", githubReleaseByTagEndpoint(tag)];
  const result = runNetwork(gh, args, { capture: true, allowFailure: true });
  if (result.status !== 0 || result.error) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim();
    if (/\bHTTP 404\b|\bstatus 404\b|\b404 Not Found\b/i.test(detail)) return null;
    throw commandResultError(gh, args, result);
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`GitHub REST release query returned invalid JSON for ${tag}`); }
  if (value?.tag_name !== tag || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") {
    throw new Error(`GitHub REST release metadata is invalid for ${tag}`);
  }
  return {
    tagName: value.tag_name,
    name: String(value.name || ""),
    targetCommitish: String(value.target_commitish || ""),
    isDraft: value.draft,
    isPrerelease: value.prerelease,
    assets: Array.isArray(value.assets) ? value.assets : [],
    url: String(value.html_url || ""),
  };
}

async function assertCoreSync({ requireReleaseAsset }) {
  const pkg = packageMetadata();
  const parsedVersion = parseReleaseVersion(pkg.version);
  const acceptance = assertLocalAcceptance();
  if (requiresSoakForStable(pkg.version)) assertStableSoak();
  const tag = `v${pkg.version}`;
  const head = output(git, ["rev-parse", "HEAD"]);
  const originMain = output(git, ["rev-parse", "origin/main"]);
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

  await waitForPublishedReleaseState(tag, parsedVersion.prerelease);

  if (requireReleaseAsset) {
    const expectedAsset = `${pkg.name}-${pkg.version}.tgz`;
    await releaseAssetInfo(tag, expectedAsset, acceptance.artifactSha256);
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

async function releaseAssetInfo(tag, assetName, expectedSha256) {
  return waitForGithubReleaseAsset(() => {
    const text = outputNetwork(gh, ["api", githubReleaseByTagEndpoint(tag)]);
    try { return JSON.parse(text); }
    catch { throw new Error(`GitHub REST release query returned invalid JSON for ${tag}`); }
  }, { tag, assetName, expectedSha256 });
}

function ensureRelease(tag, version, assetPath, { latest, prerelease }) {
  const temp = dirname(assetPath);
  const notes = writeNotesFile(temp, version);
  const existing = releaseInfo(tag);
  const title = `machine-bridge-mcp ${tag}`;
  const failures = [];

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
      prerelease ? "--prerelease" : "--prerelease=false",
    ];
    if (notes) args.push("--notes-file", notes);
    else args.push("--generate-notes");
    const created = runNetwork(gh, args, { allowFailure: true });
    if (created.status !== 0) failures.push(commandResultError(gh, args, created));
  } else {
    const editArgs = [
      "release", "edit", tag, "--title", title,
      latest ? "--latest" : "--latest=false",
      prerelease ? "--prerelease" : "--prerelease=false",
      ...(notes ? ["--notes-file", notes] : []),
    ];
    const edited = runNetwork(gh, editArgs, { allowFailure: true });
    if (edited.status !== 0) failures.push(commandResultError(gh, editArgs, edited));
    const uploadArgs = ["release", "upload", tag, assetPath, "--clobber"];
    const uploaded = runNetwork(gh, uploadArgs, { allowFailure: true });
    if (uploaded.status !== 0) failures.push(commandResultError(gh, uploadArgs, uploaded));
  }
  if (!failures.length) return null;
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "GitHub release mutation commands returned multiple errors");
}

function commandResultError(command, args, result) {
  return new Error(releaseCommandFailure(command, args, result, { maxChars: 1200 }));
}

async function waitForPublishedReleaseState(tag, prerelease, options = {}) {
  const attempts = Number.isSafeInteger(Number(options.attempts))
    ? Math.min(Math.max(Number(options.attempts), 1), 10)
    : 5;
  const wait = typeof options.wait === "function" ? options.wait : defaultReleaseStateWait;
  let release = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    release = releaseInfo(tag);
    if (release && !release.isDraft && release.isPrerelease === prerelease) return release;
    if (attempt < attempts) await wait(attempt);
  }
  throw new Error(`GitHub release ${tag} metadata did not converge after publication`);
}

function defaultReleaseStateWait(attempt) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(4_000, attempt * 1_000)); });
}

async function publishCurrent({ prereleaseMode = false } = {}) {
  ensureClean();
  fetchRemote();

  const branch = output(git, ["branch", "--show-current"]);
  if (branch !== "main") fail(`release must run from main, not ${branch || "detached HEAD"}`);

  const pkg = packageMetadata();
  const parsedVersion = parseReleaseVersion(pkg.version);
  if (prereleaseMode !== parsedVersion.prerelease) {
    fail(parsedVersion.prerelease
      ? "prerelease versions must use npm run prerelease:release -- --owner-terminal-confirm"
      : "stable versions must use npm run release -- --owner-terminal-confirm");
  }
  const tag = `v${pkg.version}`;
  if (!changelogBody(pkg.version)) {
    fail(`CHANGELOG.md has no section for ${pkg.version}`);
  }

  const npmSession = await createHardenedNpmSession();
  let acceptance;
  let verificationError = null;
  try {
    runNpmScript(npmSession.cli, "check");
    runNpmScript(npmSession.cli, "version:check");
    ensureClean();
    acceptance = assertLocalAcceptance(npmSession.cli);
    if (!parsedVersion.prerelease && requiresSoakForStable(pkg.version)) assertStableSoak(npmSession.cli);
  } catch (error) {
    verificationError = error;
  }
  let npmCleanupError = null;
  try { npmSession.dispose(); } catch (error) { npmCleanupError = error; }
  if (verificationError && npmCleanupError) {
    throw new AggregateError([verificationError, npmCleanupError], "GitHub release verification failed and hardened npm cleanup was incomplete");
  }
  if (verificationError) throw verificationError;
  if (npmCleanupError) throw npmCleanupError;

  const head = output(git, ["rev-parse", "HEAD"]);
  const originMain = output(git, ["rev-parse", "origin/main"]);
  if (head !== originMain) {
    fail("HEAD does not match origin/main; local acceptance must be committed, pushed through npm run github:push, reviewed, and merged before release publication");
  }
  assertSuccessfulCi(head);

  const candidate = stageAcceptedCandidateTarball(root, acceptance);
  let primaryError = null;
  let releaseVerified = false;
  try {
    const existingLocal = localTagCommit(tag);
    if (existingLocal && existingLocal !== head) {
      fail(`local ${tag} points to ${existingLocal}, not ${head}`);
    }
    if (!existingLocal) {
      run(git, ["tag", "-a", tag, "-m", `Release ${pkg.version}`]);
    }

    const existingRemote = remoteTagCommit(tag);
    if (existingRemote && existingRemote !== head) {
      fail(`remote ${tag} points to ${existingRemote}, not ${head}`);
    }
    if (!existingRemote) {
      runNetwork(git, ["push", "origin", tag]);
    }

    const mutationError = ensureRelease(tag, pkg.version, candidate.path, {
      latest: !parsedVersion.prerelease,
      prerelease: parsedVersion.prerelease,
    });
    let assetError = null;
    try {
      await releaseAssetInfo(tag, acceptance.metadata.filename, acceptance.artifactSha256);
      await waitForPublishedReleaseState(tag, parsedVersion.prerelease);
    } catch (error) {
      assetError = error;
    }
    if (mutationError && assetError) {
      throw new AggregateError([mutationError, assetError], "GitHub release mutation and remote-state reconciliation both failed");
    }
    if (assetError) throw assetError;
    if (mutationError) {
      console.warn("GitHub release mutation returned an error, but the exact release metadata and accepted asset bytes were verified remotely");
    }
    releaseVerified = true;
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { candidate.dispose(); } catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) throw new AggregateError([primaryError, cleanupError], "GitHub release publication failed and candidate staging cleanup was incomplete");
    throw primaryError;
  }
  if (cleanupError) {
    if (!releaseVerified) throw cleanupError;
    console.warn(`GitHub release bytes were verified but candidate staging cleanup was incomplete: ${releaseDiagnostic(cleanupError?.message || cleanupError, 600)}`);
  }

  fetchRemote();
  await assertCoreSync({ requireReleaseAsset: true });
}

function assertStableSoak(npmCli = process.env.npm_execpath) {
  try {
    const result = verifyCurrentStableSoak(root, { npmCli });
    if (result.required) {
      console.log(`Stable promotion matches soaked ${result.record.prerelease_version} (${result.promotionDigest}).`);
    }
  } catch (error) {
    fail(String(error?.message || error));
  }
}

function assertLocalAcceptance(npmCli = process.env.npm_execpath) {
  try {
    const result = verifyCurrentReleaseAcceptance(root, { npmCli });
    if (!result.required) fail("GitHub release publication requires current local candidate acceptance");
    console.log(`Interactive local candidate acceptance matches ${result.metadata.filename} (${result.metadata.shasum}).`);
    return result;
  } catch (error) {
    fail(String(error?.message || error));
  }
}

function backfillMissingReleases() {
  ensureClean();
  fetchRemote();

  const tags = output(git, ["tag", "--sort=version:refname"])
    .split("\n")
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const releases = JSON.parse(outputNetwork(gh, [
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
  let primaryError = null;
  let completed = 0;
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
      const created = runNetwork(gh, args, { allowFailure: true });
      if (created.status !== 0 && !releaseInfo(tag)) failCommandResult(gh, args, created);
      completed += 1;
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) throw new AggregateError([primaryError, cleanupError], "GitHub Release backfill failed and temporary cleanup was incomplete");
    throw primaryError;
  }
  if (cleanupError) {
    if (!completed) throw cleanupError;
    console.warn(`GitHub Release backfill completed but temporary cleanup was incomplete: ${releaseDiagnostic(cleanupError?.message || cleanupError, 600)}`);
  }

  console.log(`Backfilled ${missing.length} GitHub Release(s): ${missing.join(", ")}`);
}

const mode = process.argv[2] ?? "--check";
try {
  if (mode === "--check") {
    ensureClean();
    fetchRemote();
    await assertCoreSync({ requireReleaseAsset: true });
  } else if (mode === "--publish" || mode === "--publish-prerelease" || mode === "--backfill") {
    assertOwnerTerminalPublication();
    await withGithubPublicationLock(root, async () => {
      if (mode === "--publish") await publishCurrent({ prereleaseMode: false });
      else if (mode === "--publish-prerelease") await publishCurrent({ prereleaseMode: true });
      else backfillMissingReleases();
    });
  } else {
    fail("usage: node scripts/github-release.mjs [--check|--publish|--publish-prerelease|--backfill] [--owner-terminal-confirm]");
  }
} catch (error) {
  console.error(JSON.stringify(releaseDiagnosticEvent("github.release.failed", error?.message || error, 1600)));
  process.exitCode = 1;
}
