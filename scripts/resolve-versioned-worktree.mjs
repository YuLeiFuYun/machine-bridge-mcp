#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function parseWorktrees(text) {
  const records = [];
  let current = {};
  for (const line of `${text}\n`.split(/\r?\n/)) {
    if (!line) {
      if (Object.keys(current).length) records.push(current);
      current = {};
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (["worktree", "HEAD", "branch"].includes(key)) current[key] = value;
    else if (key === "prunable") current.prunable = true;
  }
  return records;
}

export function versionMatches(version, requested) {
  if (typeof version !== "string" || !version || typeof requested !== "string" || !requested) return false;
  const actual = version.toLowerCase();
  const wanted = requested.toLowerCase();
  if (actual === wanted) return true;
  return /^(?:dev|beta|rc)\.\d+$/.test(wanted) && actual.endsWith(`-${wanted}`);
}

export function referenceMatches(value, requested) {
  if (typeof value !== "string" || !value) return false;
  const identity = String(requested || "").toLowerCase().match(/(?:^|-)(dev|beta|rc)[._-]?(\d+)$/);
  if (identity) {
    const wantedKind = identity[1];
    const wantedNumber = identity[2];
    for (const match of value.toLowerCase().matchAll(/(?:^|[^a-z0-9])(dev|beta|rc)[._-]?(\d+)(?![0-9])/g)) {
      if (match[1] === wantedKind && match[2] === wantedNumber) return true;
    }
    return false;
  }
  const token = normalizeToken(requested);
  return Boolean(token && normalizeToken(value).includes(token));
}

export function resolveVersionedWorktree(repoPath, requestedVersion) {
  const repo = resolve(String(repoPath || ""));
  const requested = String(requestedVersion || "").trim();
  if (!requested) throw new Error("requested version must not be empty");
  const records = parseWorktrees(runGit(repo, ["worktree", "list", "--porcelain"]));
  const candidates = records.flatMap((record) => {
    if (!record.worktree) return [];
    const path = resolve(record.worktree);
    const branch = String(record.branch || "").replace(/^refs\/heads\//, "");
    const head = record.HEAD || null;
    const version = packageVersion(path);
    const headVersion = packageVersionAtHead(repo, head);
    return [{
      path,
      branch: branch || null,
      head,
      version,
      head_version: headVersion,
      working_version_diverged: version !== headVersion,
      available: directoryExists(path) && record.prunable !== true,
      branch_identity_match: referenceMatches(branch, requested),
      worktree_identity_match: referenceMatches(basename(path), requested),
    }];
  });
  const available = candidates.filter((item) => item.available);
  const identityMatches = available.filter((item) => item.branch_identity_match || item.worktree_identity_match);
  const rejectedIdentityVersionConflicts = identityMatches.filter((item) => explicitVersionConflict(item, requested));
  const eligibleIdentityMatches = identityMatches.filter((item) => !rejectedIdentityVersionConflicts.includes(item));
  const rejectedDirtyVersionMatches = [];
  let matches;
  let matchKind;
  if (eligibleIdentityMatches.length === 1) {
    matches = eligibleIdentityMatches;
    matchKind = "branch_or_worktree_identity";
  } else if (eligibleIdentityMatches.length > 1) {
    const corroborated = eligibleIdentityMatches.filter((item) => versionMatches(item.version, requested) || versionMatches(item.head_version, requested));
    matches = corroborated.length === 1 ? corroborated : eligibleIdentityMatches;
    matchKind = corroborated.length === 1 ? "identity_with_version" : "branch_or_worktree_identity";
  } else if (identityMatches.length) {
    matches = [];
    matchKind = "identity_version_conflict";
  } else {
    matches = [];
    for (const item of available.filter((candidate) => versionMatches(candidate.version, requested) || versionMatches(candidate.head_version, requested))) {
      const workingMatches = versionMatches(item.version, requested);
      const headMatches = versionMatches(item.head_version, requested);
      if (workingMatches && !headMatches && item.working_version_diverged) rejectedDirtyVersionMatches.push(item);
      else matches.push(item);
    }
    matchKind = "package_version";
  }
  if (matches.length !== 1) {
    return {
      status: matches.length ? "ambiguous" : "not_found",
      requested,
      matches,
      rejected_dirty_version_matches: rejectedDirtyVersionMatches,
      rejected_identity_version_conflicts: rejectedIdentityVersionConflicts,
      candidates,
      fallback_used: false,
    };
  }
  return { status: "resolved", requested, match_kind: matchKind, fallback_used: false, ...matches[0] };
}

function explicitVersionConflict(item, requested) {
  return Boolean(item.version && item.head_version
    && !versionMatches(item.version, requested) && !versionMatches(item.head_version, requested));
}

function packageVersion(path) {
  try {
    const value = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8")).version;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function packageVersionAtHead(repo, head) {
  if (!head) return null;
  try {
    const value = JSON.parse(runGit(repo, ["show", `${head}:package.json`])).version;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function runGit(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr || "git command failed").trim() || "git command failed");
  return result.stdout;
}

function directoryExists(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function main() {
  const args = process.argv.slice(2);
  const pathOnlyIndex = args.indexOf("--path-only");
  const pathOnly = pathOnlyIndex >= 0;
  if (pathOnly) args.splice(pathOnlyIndex, 1);
  if (args.length !== 2) {
    console.error("usage: node scripts/resolve-versioned-worktree.mjs <repo-worktree> <version> [--path-only]");
    return 4;
  }
  try {
    const result = resolveVersionedWorktree(args[0], args[1]);
    if (pathOnly && result.status === "resolved") console.log(result.path);
    else console.log(JSON.stringify(result, null, 2));
    return result.status === "resolved" ? 0 : result.status === "ambiguous" ? 3 : 2;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exitCode = await main();
