#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { resolveTrustedGithubCli } from "../src/local/trusted-github-cli.mjs";
import { releaseCommandFailure, releaseDiagnostic } from "./release-diagnostic.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function closingIssueNumbers(messages) {
  const numbers = new Set();
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+#(\d+)\b/gi;
  for (const match of String(messages || "").matchAll(pattern)) numbers.add(Number(match[1]));
  return numbers;
}

export function backlogBlockers({ issues = [], pullRequests = [], branch = "", commitMessages = "" }) {
  const closing = closingIssueNumbers(commitMessages);
  const issueBlockers = issues.filter((issue) => !closing.has(Number(issue.number)));
  const pullRequestBlockers = pullRequests.filter((pull) => !(
    String(pull.headRefName || "") === branch
    && pull.headRepository
    && pull.headRepository === pull.baseRepository
  ));
  return { issueBlockers, pullRequestBlockers, closing: [...closing].sort((left, right) => left - right) };
}

export function assertGitHubBacklogReady(options = {}) {
  const run = options.run || runCommand;
  const cwd = options.cwd || root;
  const git = options.git || resolveTrustedGitExecutable({ workspace: cwd });
  const gh = options.gh || resolveTrustedGithubCli({ workspace: cwd });
  const branch = options.branch || output(run, git, ["branch", "--show-current"], cwd);
  if (!branch) throw new Error("cannot inspect GitHub backlog from a detached HEAD");
  const commitMessages = output(run, git, ["log", "--format=%B%x00", "origin/main..HEAD"], cwd);
  const issueRows = pagedJson(output(run, gh, [
    "api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues?state=open&per_page=100",
  ], cwd), "open GitHub issues");
  const pullRows = pagedJson(output(run, gh, [
    "api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls?state=open&per_page=100",
  ], cwd), "open GitHub pull requests");
  const issues = issueRows
    .filter((item) => !item.pull_request)
    .map((item) => ({ number: item.number, title: item.title, url: item.html_url }));
  const pullRequests = pullRows.map((item) => ({
    number: item.number,
    title: item.title,
    headRefName: item.head?.ref,
    headRepository: item.head?.repo?.full_name,
    baseRepository: item.base?.repo?.full_name,
    url: item.html_url,
  }));
  const blockers = backlogBlockers({ issues, pullRequests, branch, commitMessages });
  if (!blockers.issueBlockers.length && !blockers.pullRequestBlockers.length) {
    const covered = blockers.closing.length ? `; closing issue(s): ${blockers.closing.map((number) => `#${number}`).join(", ")}` : "";
    return { branch, issues, pullRequests, ...blockers, message: `GitHub backlog gate passed${covered}.` };
  }
  throw new Error(formatBlockers(blockers, branch));
}

function formatBlockers(blockers, branch) {
  const lines = ["GitHub backlog is not ready for another push."];
  if (blockers.issueBlockers.length) {
    lines.push("Open issues not closed by a commit in origin/main..HEAD:");
    for (const issue of blockers.issueBlockers) lines.push(`- #${issue.number} ${boundedTitle(issue.title)}${issue.url ? ` (${issue.url})` : ""}`);
  }
  if (blockers.pullRequestBlockers.length) {
    lines.push(`Open pull requests other than the current branch (${branch}):`);
    for (const pull of blockers.pullRequestBlockers) lines.push(`- #${pull.number} ${boundedTitle(pull.title)} [${pull.headRefName || "unknown branch"}]${pull.url ? ` (${pull.url})` : ""}`);
  }
  lines.push("Resolve or close every blocker before pushing. The current branch may cover an issue with a standard closing keyword such as 'Closes #47'.");
  return lines.join("\n");
}

function boundedTitle(value) {
  return String(value || "untitled").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function pagedJson(text, label) {
  let pages;
  try { pages = JSON.parse(text || "[]"); }
  catch (error) { throw new Error(`${label} response was not valid JSON: ${error.message}`); }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} response was not a slurped page array`);
  }
  return pages.flat();
}

function output(run, command, args, cwd) {
  const result = run(command, args, cwd);
  return String(result.stdout || "").trim();
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure(command, args, result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = assertGitHubBacklogReady();
    console.log(result.message);
  } catch (error) {
    console.error(`GitHub backlog gate failed: ${releaseDiagnostic(error?.message || error, 1200)}`);
    process.exit(1);
  }
}
