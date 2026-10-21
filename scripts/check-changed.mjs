import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "./source-syntax.mjs";
import { FAST_CHECK_TASKS, SERIAL_FAST_CHECK_TASKS } from "./check-plan.mjs";
import { directNodeInvocation, runVerificationPlan } from "./check-runner.mjs";

const CODE = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const BASE_CHECKS = ["privacy:check", "architecture:test", "lint", "typecheck", "syntax"];

function sourceDependencies(text, filename) {
  const nodes = [parseAst(text, filename)];
  const dependencies = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node.type !== "string") continue;
    let value;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) value = node.source;
    else if (node.type === "CallExpression" && node.callee?.name === "require") value = node.arguments?.[0];
    else if (node.type === "NewExpression" && node.callee?.name === "URL") value = node.arguments?.[0];
    if (value?.type === "StringLiteral" && value.value.startsWith(".")) dependencies.push(value.value);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) nodes.push(...child);
      else if (child && typeof child === "object") nodes.push(child);
    }
  }
  return dependencies;
}

export function selectAffectedChecks({ root, changedPaths, files, packageScripts, readSource = (path) => readFileSync(path, "utf8") }) {
  const changed = [...new Set(changedPaths)];
  const selected = new Set(BASE_CHECKS);
  let fallbackReason = null;
  const full = (reason) => { fallbackReason = reason; for (const task of FAST_CHECK_TASKS) selected.add(task); };
  if (!changed.length) {
    return plan([], "no_changes");
  }
  if (changed.every((path) => /^(?:docs\/.*\.md|(?:README|CHANGELOG|CONTRIBUTING|AGENTS|SECURITY|SUPPORT|GOVERNANCE)\.md)$/.test(path))) {
    return plan(["privacy:check", "architecture:test", "markdown:test", "tool-docs:check", "policy-docs:check"], "documentation");
  }
  if (changed.some((path) => !/^(?:src|tests|scripts|browser-extension)\//.test(path) || (!CODE.has(extname(path)) && extname(path) !== ".json"))) {
    full("configuration_or_unclassified_change");
    return plan([...selected], "fast_fallback");
  }
  const reverse = new Map();
  try {
    for (const path of files.filter((name) => CODE.has(extname(name)))) {
      for (const dependency of sourceDependencies(readSource(resolve(root, path)), path)) {
        const candidate = relative(root, resolve(root, dirname(path), dependency)).replaceAll("\\", "/");
        for (const target of [candidate, ...[".mjs", ".js", ".ts", ".json"].map((extension) => candidate + extension)]) {
          if (!reverse.has(target)) reverse.set(target, new Set());
          reverse.get(target).add(path);
        }
      }
    }
  } catch {
    full("dependency_parse_failed");
    return plan([...selected], "fast_fallback");
  }
  const impacted = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const consumer of reverse.get(queue.shift()) || []) if (!impacted.has(consumer)) { impacted.add(consumer); queue.push(consumer); }
  }
  for (const task of FAST_CHECK_TASKS) {
    const invocation = directNodeInvocation(task, packageScripts);
    if (invocation?.args.some((argument) => impacted.has(argument))) selected.add(task);
  }
  if (changed.some((path) => path.startsWith("src/")) && selected.size === BASE_CHECKS.length) full("no_test_entrypoint_reached");
  return plan([...selected], fallbackReason ? "fast_fallback" : "static_dependency_selection");

  function plan(tasks, mode) {
    const set = new Set(tasks);
    return {
      mode, advisory: true, changed_paths: changed, fallback_reason: fallbackReason,
      selected: FAST_CHECK_TASKS.filter((task) => set.has(task)),
      not_selected: FAST_CHECK_TASKS.filter((task) => !set.has(task)),
      proof_boundary: "Development feedback from static imports, require and file URLs. Dynamic paths, platform behavior, packaging and live acceptance still require the full release gates.",
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--plan")) throw new Error("usage: npm run check:changed -- [--plan]");
  const gitNames = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = gitNames("ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const changedPaths = [...gitNames("diff", "--name-only", "-z", "HEAD", "--"), ...gitNames("ls-files", "-z", "--others", "--exclude-standard")];
  const packageScripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
  const result = selectAffectedChecks({ root, files, changedPaths, packageScripts });
  console.log(JSON.stringify(result, null, 2));
  if (!args.includes("--plan") && result.selected.length) {
    const serial = new Set(SERIAL_FAST_CHECK_TASKS);
    await runVerificationPlan({ mode: "changed (advisory)", tasks: result.selected, packageScripts, npmCli: process.env.npm_execpath,
      concurrency: 4, parallelTaskNames: new Set(result.selected.filter((task) => !serial.has(task))) });
  }
}
