import { execFileSync } from "node:child_process";
import process from "node:process";
import { createTrustedGitResolver } from "../src/local/trusted-git-executable.mjs";

const gitExecutable = createTrustedGitResolver({ workspace: process.cwd() });

const allowedTypes = Object.freeze([
  "feat",
  "fix",
  "docs",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "security",
  "release",
  "revert",
]);
const subjectPattern = new RegExp(`^(?:${allowedTypes.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: [^\\s].*$`);
const titles = readTitles(process.argv.slice(2));
const failures = [];

for (const title of titles) {
  const normalized = String(title).trim();
  if (!normalized) {
    failures.push("commit or pull-request title is empty");
    continue;
  }
  if (normalized.length > 120) failures.push(`title exceeds 120 characters: ${normalized}`);
  if (!subjectPattern.test(normalized)) {
    failures.push(`invalid Conventional Commit title: ${normalized}`);
  }
}

if (failures.length) {
  console.error([
    ...failures,
    "Expected: <type>[optional scope][optional !]: <imperative description>",
    `Allowed types: ${allowedTypes.join(", ")}`,
  ].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`commit message check ok (${titles.length} title${titles.length === 1 ? "" : "s"})`);
}

function readTitles(args) {
  const titleIndex = args.indexOf("--title");
  if (titleIndex !== -1) {
    const title = args[titleIndex + 1];
    if (title === undefined) throw new Error("--title requires a value");
    return [title];
  }

  const rangeIndex = args.indexOf("--range");
  if (rangeIndex !== -1) {
    const range = args[rangeIndex + 1];
    if (!range) throw new Error("--range requires a Git revision range");
    return execFileSync(gitExecutable(), ["log", "--format=%s", range], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  }

  return [execFileSync(gitExecutable(), ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim()];
}
