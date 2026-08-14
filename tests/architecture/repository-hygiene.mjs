import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { resolveTrustedGitExecutable } from "../../src/local/trusted-git-executable.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const docs = [
  join(root, "README.md"),
  join(root, "SECURITY.md"),
  join(root, "CONTRIBUTING.md"),
  join(root, "CODE_OF_CONDUCT.md"),
  join(root, "SUPPORT.md"),
  join(root, "GOVERNANCE.md"),
  ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => join(root, "docs", name)),
];
for (const file of docs) validateRelativeLinks(file);
validateCurrentMcpDeliveryDocumentation();

const repositoryFiles = execFileSync(resolveTrustedGitExecutable({ workspace: root }), ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const workflowFiles = repositoryFiles.filter((name) => /^\.github\/workflows\/.*\.ya?ml$/i.test(name));
for (const name of workflowFiles) {
  const source = readFileSync(join(root, name), "utf8");
  const jobsIndex = source.search(/^jobs:/m);
  const permissionsIndex = source.search(/^permissions:/m);
  if (permissionsIndex === -1 || jobsIndex === -1 || permissionsIndex > jobsIndex) {
    throw new Error(`GitHub workflow ${name} lacks explicit top-level permissions before jobs`);
  }
  if (/^\s*pull_request_target:/m.test(source)) throw new Error(`privileged pull_request_target trigger is prohibited in ${name}`);
  if (/^permissions:\s*write-all\s*$/m.test(source)) throw new Error(`write-all workflow permissions are prohibited in ${name}`);
  for (const match of source.matchAll(/\buses:\s*([^@\s]+)@([^\s#]+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(match[2])) throw new Error(`GitHub Action ${match[1]} in ${name} is not pinned to an immutable commit SHA`);
  }
}
for (const requiredWorkflow of ["ci.yml", "governance.yml", "codeql.yml", "dependency-review.yml", "scorecard.yml", "workflow-policy.yml"]) {
  if (!workflowFiles.includes(`.github/workflows/${requiredWorkflow}`)) throw new Error(`required workflow is missing: ${requiredWorkflow}`);
}
for (const name of repositoryFiles) {
  const file = join(root, name);
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0) || !isUtf8(bytes)) continue;
  validateExactlyOneFinalLf(bytes, name);
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if ((value < 32 && value !== 9 && value !== 10 && value !== 13) || value === 127) {
      throw new Error(`forbidden ASCII control byte 0x${value.toString(16).padStart(2, "0")} in ${name} at byte ${index}`);
    }
  }
}

function validateExactlyOneFinalLf(bytes, name) {
  if (bytes.length === 0) return;
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new Error(`reviewable text file must end with LF: ${name}`);
  }
  let priorIndex = bytes.length - 2;
  if (priorIndex >= 0 && bytes[priorIndex] === 0x0d) priorIndex -= 1;
  if (priorIndex >= 0 && bytes[priorIndex] === 0x0a) {
    throw new Error(`reviewable text file must not end with a blank line: ${name}`);
  }
}

assert.doesNotThrow(() => validateExactlyOneFinalLf(Buffer.from("valid\n"), "valid-LF fixture"));
assert.doesNotThrow(() => validateExactlyOneFinalLf(Buffer.from("valid\r\n"), "valid-CRLF fixture"));
assert.throws(
  () => validateExactlyOneFinalLf(Buffer.from("missing"), "missing-final-LF fixture"),
  /must end with LF/,
);
for (const [name, value] of [
  ["LF blank-line fixture", "blank\n\n"],
  ["CRLF blank-line fixture", "blank\r\n\r\n"],
  ["LF-CRLF blank-line fixture", "blank\n\r\n"],
  ["CRLF-LF blank-line fixture", "blank\r\n\n"],
]) {
  assert.throws(
    () => validateExactlyOneFinalLf(Buffer.from(value), name),
    /must not end with a blank line/,
  );
}

function validateCurrentMcpDeliveryDocumentation() {
  const security = readFileSync(join(root, "SECURITY.md"), "utf8");
  for (const obsolete of [
    "## Resumable Streamable HTTP delivery",
    "SSE event identifiers are cursors",
    "The Worker stores bounded stream and call state to bridge transport loss",
  ]) {
    if (security.includes(obsolete)) throw new Error(`SECURITY.md regained obsolete MCP replay semantics: ${obsolete}`);
  }
  for (const required of ["## Request-scoped Streamable HTTP delivery", "request-scoped and non-resumable", "does not restore the removed session model"]) {
    if (!security.includes(required)) throw new Error(`SECURITY.md lost current MCP delivery semantics: ${required}`);
  }

  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const obsolete of ["there is no `initialize` handshake", "upgrade guidance for an obsolete `initialize`"]) {
    if (readme.includes(obsolete)) throw new Error(`README.md regained obsolete all-initialize-rejected semantics: ${obsolete}`);
  }
  for (const required of [
    "MCP `2026-07-28` as its native protocol",
    "stateless initialization compatibility",
    "`2025-06-18` and `2025-11-25`",
    "does not create or accept `Mcp-Session-Id`",
  ]) {
    if (!readme.includes(required)) throw new Error(`README.md lost current native/stateless-compatibility semantics: ${required}`);
  }

  const overview = readFileSync(join(root, "docs", "OVERVIEW.md"), "utf8");
  if (!overview.includes("organized around four independent questions") || overview.includes("MCP session state")) {
    throw new Error("OVERVIEW.md drifted from the current request-scoped MCP authority model");
  }
}

function validateRelativeLinks(file) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = raw.split("#", 1)[0];
    if (!path) continue;
    const target = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(target)) throw new Error(`broken relative documentation link in ${relative(root, file)}: ${raw}`);
  }
}

console.log(`architecture repository hygiene ok (${docs.length} documentation files)`);
