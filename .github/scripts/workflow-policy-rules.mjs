const ALLOWED_TRIGGERS = new Set([
  "branch_protection_rule",
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
]);
const ALLOWED_ACTIONS = new Set([
  "actions/checkout",
  "actions/dependency-review-action",
  "actions/download-artifact",
  "actions/setup-node",
  "actions/upload-artifact",
  "github/codeql-action/analyze",
  "github/codeql-action/init",
  "github/codeql-action/upload-sarif",
  "ossf/scorecard-action",
]);
const ALLOWED_WRITE_PERMISSIONS = new Set([
  "codeql.yml:analyze:security-events",
  "scorecard.yml:analysis:id-token",
  "scorecard.yml:gate:security-events",
]);

export function verifyWorkflowSource(source, name) {
  verifyTextShape(source, name);
  const sections = topLevelSections(source, name);
  for (const required of ["name", "on", "permissions", "concurrency", "jobs"]) {
    if (!sections.has(required)) throw new Error(`workflow ${name} is missing top-level ${required}`);
  }
  const jobsIndex = sections.get("jobs").start;
  if (sections.get("permissions").start > jobsIndex) throw new Error(`workflow ${name} declares permissions after jobs`);
  verifyTriggers(sections.get("on"), name);
  verifyTopLevelPermissions(sections.get("permissions"), name);
  verifyConcurrency(sections.get("concurrency"), name);
  verifyJobs(sections.get("jobs"), name);
  verifyActions(source, name);
  verifyExpressionBoundaries(source, name);
}

export function countWorkflowActions(sources) {
  let count = 0;
  for (const source of sources.values()) count += [...source.matchAll(/^\s*-?\s*uses:/gm)].length;
  return count;
}

function verifyTextShape(source, name) {
  if (!source || !source.endsWith("\n")) throw new Error(`workflow ${name} must end with one newline`);
  if (source.charCodeAt(0) === 0xfeff) throw new Error(`workflow ${name} must not contain a UTF-8 BOM`);
  if (source.includes("\r")) throw new Error(`workflow ${name} must use LF line endings`);
  if (source.includes("\t")) throw new Error(`workflow ${name} must not contain tab indentation`);
  if (/ +$/m.test(source)) throw new Error(`workflow ${name} contains trailing whitespace`);
  if (/^\s*pull_request_target\s*:/m.test(source)) throw new Error(`workflow ${name} uses prohibited pull_request_target`);
  if (/^\s*(?:workflow_run|repository_dispatch|issue_comment)\s*:/m.test(source)) {
    throw new Error(`workflow ${name} uses a prohibited privileged or externally triggered event`);
  }
  if (/^\s*permissions:\s*write-all\s*$/m.test(source)) throw new Error(`workflow ${name} uses prohibited write-all permissions`);
  if (/(?:toJSON|toJson)\s*\(\s*secrets\s*\)|\$\{\{\s*(?:secrets\.|github\.token)|\bGITHUB_TOKEN\b/i.test(source)) {
    throw new Error(`workflow ${name} exposes or references repository credentials`);
  }
  if (/^\s*<<\s*:/m.test(source) || /:\s*&[A-Za-z0-9_-]+\s*$/m.test(source)) {
    throw new Error(`workflow ${name} uses YAML merge or anchor features that obscure review`);
  }
}

function topLevelSections(source, name) {
  const lines = source.split("\n");
  const positions = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(lines[index]);
    if (!match) continue;
    if (seen.has(match[1])) throw new Error(`workflow ${name} repeats top-level key ${match[1]}`);
    seen.add(match[1]);
    positions.push({ key: match[1], start: index, inline: String(match[2] || "").trim() });
  }
  const sections = new Map();
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index];
    const end = positions[index + 1]?.start ?? lines.length;
    sections.set(current.key, { ...current, lines: lines.slice(current.start + 1, end) });
  }
  return sections;
}

function verifyTriggers(section, name) {
  if (section.inline) throw new Error(`workflow ${name} must declare triggers as a reviewable block`);
  const triggers = section.lines
    .map((line) => /^  ([A-Za-z][A-Za-z0-9_-]*):/.exec(line)?.[1])
    .filter(Boolean);
  if (!triggers.length) throw new Error(`workflow ${name} declares no triggers`);
  for (const trigger of triggers) {
    if (!ALLOWED_TRIGGERS.has(trigger)) throw new Error(`workflow ${name} uses unreviewed trigger ${trigger}`);
  }
}

function verifyTopLevelPermissions(section, name) {
  if (section.inline) {
    if (section.inline !== "read-all") throw new Error(`workflow ${name} top-level permissions must be read-all or an explicit read-only map`);
    return;
  }
  const permissions = indentedMap(section.lines, 2);
  if (!permissions.size) throw new Error(`workflow ${name} has an empty top-level permissions map`);
  for (const [permission, value] of permissions) {
    if (!["read", "none"].includes(value)) throw new Error(`workflow ${name} grants top-level ${permission}: ${value}`);
  }
}

function verifyConcurrency(section, name) {
  if (section.inline) throw new Error(`workflow ${name} must declare concurrency as a block`);
  const concurrency = indentedMap(section.lines, 2);
  const group = concurrency.get("group") || "";
  if (!group.includes("github.workflow") || !group.includes("github.ref")) {
    throw new Error(`workflow ${name} concurrency group must bind github.workflow and github.ref`);
  }
  if (concurrency.get("cancel-in-progress") !== "true") throw new Error(`workflow ${name} must cancel superseded runs`);
}

function verifyJobs(section, name) {
  if (section.inline) throw new Error(`workflow ${name} must declare jobs as a block`);
  const jobs = splitJobs(section.lines, name);
  if (!jobs.length) throw new Error(`workflow ${name} declares no jobs`);
  for (const job of jobs) {
    if (!/^    runs-on:\s*\S+/m.test(job.source)) throw new Error(`workflow ${name} job ${job.name} has no runner`);
    const timeout = Number(/^    timeout-minutes:\s*(\d+)\s*$/m.exec(job.source)?.[1]);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
      throw new Error(`workflow ${name} job ${job.name} must have a timeout from 1 to 30 minutes`);
    }
    verifyJobPermissions(job, name);
  }
}

function verifyJobPermissions(job, name) {
  const lines = job.source.split("\n");
  const index = lines.findIndex((line) => /^    permissions:\s*$/.test(line));
  if (index < 0) return;
  const permissions = indentedMap(lines.slice(index + 1), 6);
  for (const [permission, value] of permissions) {
    if (["read", "none"].includes(value)) continue;
    if (value !== "write" || !ALLOWED_WRITE_PERMISSIONS.has(`${name}:${job.name}:${permission}`)) {
      throw new Error(`workflow ${name} job ${job.name} grants unreviewed ${permission}: ${value}`);
    }
  }
}

function verifyActions(source, name) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-?\s*uses:/.test(lines[index])) continue;
    const match = /^\s*-?\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{40})\s*(?:#.*)?$/.exec(lines[index]);
    if (!match) throw new Error(`workflow ${name} contains a dynamic, malformed, or unpinned action reference`);
    if (!ALLOWED_ACTIONS.has(match[1])) throw new Error(`workflow ${name} uses unreviewed action ${match[1]}`);
    const block = stepBlock(lines, index);
    if (match[1] === "actions/checkout" && !/^\s+persist-credentials:\s*false\s*$/m.test(block)) {
      throw new Error(`workflow ${name} checkout must disable persisted credentials`);
    }
    if (match[1] === "actions/setup-node") {
      if (!/^\s+node-version-file:\s*\.node-version\s*$/m.test(block)) throw new Error(`workflow ${name} setup-node must use .node-version`);
      if (!/^\s+package-manager-cache:\s*false\s*$/m.test(block)) throw new Error(`workflow ${name} setup-node must disable implicit package-manager caching`);
    }
  }
}

function verifyExpressionBoundaries(source, name) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const block = [match[2]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() && leadingSpaces(lines[cursor]) <= indent) break;
      block.push(lines[cursor]);
    }
    if (/\$\{\{\s*github\.event\./.test(block.join("\n"))) {
      throw new Error(`workflow ${name} interpolates github.event data directly into a shell command`);
    }
  }
}

function splitJobs(lines, workflowName) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^  ([A-Za-z][A-Za-z0-9_-]*):\s*$/.exec(lines[index]);
    if (match) starts.push({ name: match[1], index });
  }
  const jobs = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const end = starts[index + 1]?.index ?? lines.length;
    if (jobs.some((job) => job.name === current.name)) throw new Error(`workflow ${workflowName} repeats job ${current.name}`);
    jobs.push({ name: current.name, source: lines.slice(current.index, end).join("\n") });
  }
  return jobs;
}

function indentedMap(lines, spaces) {
  const map = new Map();
  const pattern = new RegExp(`^ {${spaces}}([A-Za-z][A-Za-z0-9_-]*):\\s*(.*?)\\s*$`);
  for (const line of lines) {
    if (line.trim() && leadingSpaces(line) < spaces) break;
    const match = pattern.exec(line);
    if (!match) continue;
    if (map.has(match[1])) throw new Error(`mapping repeats key ${match[1]}`);
    map.set(match[1], match[2]);
  }
  return map;
}

function stepBlock(lines, index) {
  const indent = leadingSpaces(lines[index]);
  const out = [lines[index]];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (new RegExp(`^ {${indent}}- `).test(lines[cursor])) break;
    out.push(lines[cursor]);
  }
  return out.join("\n");
}

function leadingSpaces(line) {
  return /^ */.exec(line)?.[0].length ?? 0;
}
