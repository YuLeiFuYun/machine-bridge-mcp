#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedRegularFileSync } from "../../src/local/secure-file.mjs";
import { REQUIRED_WORKFLOWS, verifyWorkflowSet } from "./workflow-policy-contract.mjs";
import { countWorkflowActions, verifyWorkflowSource } from "./workflow-policy-rules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_WORKFLOW_BYTES = 256 * 1024;

export function verifyWorkflowPolicy(repositoryRoot = root) {
  const repository = realDirectory(repositoryRoot, "repository root");
  const githubDirectory = join(repository, ".github");
  const canonicalGithubDirectory = realDirectory(githubDirectory, "GitHub control directory");
  requireContained(repository, canonicalGithubDirectory, "GitHub control directory");
  const workflowDirectory = join(canonicalGithubDirectory, "workflows");
  const canonicalWorkflowDirectory = realDirectory(workflowDirectory, "workflow directory");
  requireContained(canonicalGithubDirectory, canonicalWorkflowDirectory, "workflow directory");

  const names = readdirSync(canonicalWorkflowDirectory, { withFileTypes: true })
    .filter((entry) => /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const required of REQUIRED_WORKFLOWS) {
    if (!names.includes(required)) throw new Error(`required workflow is missing: ${required}`);
  }

  const sources = new Map();
  for (const name of names) {
    const path = join(canonicalWorkflowDirectory, name);
    sources.set(name, verifyWorkflowFile(path, { name, workflowDirectory: canonicalWorkflowDirectory }));
  }
  verifyWorkflowSet(sources);
  return { files: names, actions: countWorkflowActions(sources) };
}

export function verifyWorkflowFile(path, { name = path, workflowDirectory = dirname(path) } = {}) {
  const canonicalDirectory = realDirectory(workflowDirectory, "workflow directory");
  const pathInfo = lstatSync(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`workflow ${name} must be a regular file and not a symbolic link`);
  const canonicalPath = realpathSync(path);
  requireContained(canonicalDirectory, canonicalPath, `workflow ${name}`);
  const bytes = readBoundedRegularFileSync(path, MAX_WORKFLOW_BYTES, `workflow ${name}`, {
    verifyPathIdentity: true,
    rejectMultipleLinks: true,
  });
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`workflow ${name} is not valid UTF-8`, { cause: error }); }
  verifyWorkflowSource(source, name);
  return source;
}

function realDirectory(path, label) {
  const target = resolve(String(path || ""));
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return realpathSync(target);
}

function requireContained(parent, child, label) {
  const value = relative(parent, child);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} escapes its parent directory`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyWorkflowPolicy(root);
    console.log(`workflow policy verified (${result.files.length} workflows, ${result.actions} pinned action references)`);
  } catch (error) {
    console.error(`workflow policy verification failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
