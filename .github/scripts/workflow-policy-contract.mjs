export const REQUIRED_WORKFLOWS = Object.freeze([
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "governance.yml",
  "scorecard.yml",
  "workflow-policy.yml",
]);

const ACTION_SHA = "[0-9a-f]{40}";

export function verifyWorkflowSet(sources) {
  const ci = requiredSource(sources, "ci.yml");
  for (const command of [
    "npm run check:platform",
    "npm run check:full",
    "npm run privacy:history",
    "npm run consumer-security:test",
    "npm audit signatures",
    "npm run install:test",
  ]) requireRunCommand(ci, "ci.yml", command);
  requireRunMatch(
    ci,
    "ci.yml",
    "local candidate acceptance",
    /^npm pack --ignore-scripts --silent --dry-run --json \| node \.github\/scripts\/verify-release-acceptance\.mjs$/,
  );

  const codeql = requiredSource(sources, "codeql.yml");
  requireJobLine(codeql, "codeql.yml", "analyze", /^        language: \[javascript-typescript, actions\]$/, "CodeQL language matrix");
  requireActionInput(codeql, "codeql.yml", "github/codeql-action/init", "queries", "security-extended,security-and-quality");
  requireRunMatch(
    codeql,
    "codeql.yml",
    "CodeQL SARIF security gate",
    /^node scripts\/sarif-security-gate\.mjs\s+"\$\{\{ steps\.analyze\.outputs\.sarif-output \}\}"$/,
  );

  const dependencyReview = requiredSource(sources, "dependency-review.yml");
  requireActionInput(dependencyReview, "dependency-review.yml", "actions/dependency-review-action", "fail-on-severity", "moderate");

  const governance = requiredSource(sources, "governance.yml");
  const governanceStep = requireRunStep(
    governance,
    "governance.yml",
    "commit-message policy",
    (command) => command === "node scripts/commit-message-check.mjs --title \"$PR_TITLE\"",
  );
  requireNestedMapping(
    governanceStep.lines,
    "governance.yml",
    "commit-message policy",
    "env",
    "PR_TITLE",
    /^\$\{\{ github\.event\.pull_request\.title \|\| '' \}\}$/,
  );
  requireRunCommand(governance, "governance.yml", "node scripts/commit-message-check.mjs");

  const scorecard = requiredSource(sources, "scorecard.yml");
  requireActionInput(scorecard, "scorecard.yml", "ossf/scorecard-action", "publish_results", "true");
  requireActionInput(scorecard, "scorecard.yml", "actions/upload-artifact", "retention-days", "5");
  requireJobLine(scorecard, "scorecard.yml", "gate", /^    name: Scorecard gate$/, "Scorecard gate job name");
  requireRunCommand(
    scorecard,
    "scorecard.yml",
    "node scripts/sarif-security-gate.mjs .scorecard-results/results.sarif --allowlist=.github/scorecard-accepted-findings.json",
  );
  requireAction(scorecard, "scorecard.yml", "github/codeql-action/upload-sarif");

  const workflowPolicy = requiredSource(sources, "workflow-policy.yml");
  requireTopLevelScalar(workflowPolicy, "workflow-policy.yml", "name", "Workflow Policy Gate");
  requireRunCommand(workflowPolicy, "workflow-policy.yml", "node .github/scripts/workflow-policy.mjs");
  requireRunCommand(workflowPolicy, "workflow-policy.yml", "node tests/workflow-policy-test.mjs");
}

function requiredSource(sources, name) {
  const source = sources.get(name);
  if (!source) throw new Error(`required workflow is missing: ${name}`);
  return source;
}

function requireTopLevelScalar(source, name, key, value) {
  const pattern = new RegExp(`^${escapeRegex(key)}:\\s*${escapeRegex(value)}\\s*$`);
  if (!logicalLines(source).some((line) => pattern.test(line))) {
    throw new Error(`workflow ${name} lost required top-level ${key}: ${value}`);
  }
}

function requireRunCommand(source, name, command) {
  if (!runCommands(source).includes(command)) {
    throw new Error(`workflow ${name} lost required executable run command: ${command}`);
  }
}

function requireRunMatch(source, name, label, pattern) {
  if (!runCommands(source).some((command) => pattern.test(command))) {
    throw new Error(`workflow ${name} lost required executable ${label}`);
  }
}

function requireRunStep(source, name, label, predicate) {
  const step = sequenceBlocks(source).find((block) => runCommandsFromBlock(block).some(predicate));
  if (!step) throw new Error(`workflow ${name} lost required executable ${label}`);
  return step;
}

function requireAction(source, name, action) {
  if (!actionSteps(source, action).length) throw new Error(`workflow ${name} lost required action step: ${action}`);
}

function requireActionInput(source, name, action, key, value) {
  const steps = actionSteps(source, action);
  if (!steps.length) throw new Error(`workflow ${name} lost required action step: ${action}`);
  if (!steps.some((step) => nestedMappingValue(step.lines, "with", key) === value)) {
    throw new Error(`workflow ${name} action ${action} lost required input ${key}: ${value}`);
  }
}

function requireJobLine(source, name, jobName, pattern, label) {
  const lines = jobLines(source, jobName);
  if (!lines || !lines.map(stripYamlComment).some((line) => pattern.test(line))) {
    throw new Error(`workflow ${name} lost required ${label}`);
  }
}

function requireNestedMapping(lines, name, label, mapping, key, valuePattern) {
  const value = nestedMappingValue(lines, mapping, key);
  if (value === null || !valuePattern.test(value)) {
    throw new Error(`workflow ${name} lost required ${label} ${mapping}.${key}`);
  }
}

function nestedMappingValue(lines, mapping, key) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index]);
    const mappingMatch = new RegExp(`^(\\s*)${escapeRegex(mapping)}:\\s*$`).exec(line);
    if (!mappingMatch) continue;
    const mappingIndent = mappingMatch[1].length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = stripYamlComment(lines[cursor]);
      if (!candidate.trim()) continue;
      if (leadingSpaces(candidate) <= mappingIndent) break;
      const valueMatch = new RegExp(`^\\s*${escapeRegex(key)}:\\s*(.*?)\\s*$`).exec(candidate);
      if (valueMatch) return valueMatch[1];
    }
  }
  return null;
}

function actionSteps(source, action) {
  const pattern = new RegExp(`^\\s*(?:-\\s*)?uses:\\s*${escapeRegex(action)}@${ACTION_SHA}\\s*(?:#.*)?$`);
  return sequenceBlocks(source).filter((block) => block.lines.map(stripYamlComment).some((line) => pattern.test(line)));
}

function runCommands(source) {
  return sequenceBlocks(source).flatMap(runCommandsFromBlock);
}

function runCommandsFromBlock(block) {
  const commands = [];
  for (let index = 0; index < block.lines.length; index += 1) {
    const line = stripYamlComment(block.lines[index]);
    const match = /^(\s*)(?:-\s*)?run:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const scalar = match[2];
    if (!/^[>|][+-]?$/.test(scalar)) {
      if (scalar) commands.push(unquoteScalar(scalar));
      continue;
    }
    for (let cursor = index + 1; cursor < block.lines.length; cursor += 1) {
      const candidate = stripYamlComment(block.lines[cursor]);
      if (!candidate.trim()) continue;
      if (leadingSpaces(candidate) <= indent) break;
      commands.push(candidate.trim());
    }
  }
  return commands;
}

function sequenceBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index]);
    const match = /^(\s*)-\s+\S/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const candidate = stripYamlComment(lines[end]);
      if (candidate.trim() && leadingSpaces(candidate) <= indent) break;
    }
    blocks.push({ start: index, lines: lines.slice(index, end) });
    index = end - 1;
  }
  return blocks;
}

function jobLines(source, jobName) {
  const lines = source.split("\n");
  const jobsIndex = lines.findIndex((line) => stripYamlComment(line) === "jobs:");
  if (jobsIndex < 0) return null;
  const pattern = new RegExp(`^  ${escapeRegex(jobName)}:\\s*$`);
  const start = lines.findIndex((line, index) => index > jobsIndex && pattern.test(stripYamlComment(line)));
  if (start < 0) return null;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const candidate = stripYamlComment(lines[end]);
    if (/^  [A-Za-z][A-Za-z0-9_-]*:\s*$/.test(candidate)) break;
    if (candidate.trim() && leadingSpaces(candidate) < 2) break;
  }
  return lines.slice(start, end);
}

function logicalLines(source) {
  return source.split("\n").map(stripYamlComment).filter((line) => line.trim());
}

function stripYamlComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && line[index + 1] === "'") index += 1;
      else if (char === "'") quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function unquoteScalar(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) return value.slice(1, -1);
  return value;
}

function leadingSpaces(line) {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
