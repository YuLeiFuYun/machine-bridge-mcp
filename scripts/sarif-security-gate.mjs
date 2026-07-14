import { readFileSync, readdirSync, statSync } from "node:fs";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const targets = args.filter((value) => !value.startsWith("--"));
const allowlistOption = args.find((value) => value.startsWith("--allowlist="));
const allowlistPath = resolve(root, allowlistOption ? allowlistOption.slice("--allowlist=".length) : ".github/codeql-accepted-findings.json");
if (!targets.length) throw new Error("usage: node scripts/sarif-security-gate.mjs SARIF_PATH [...SARIF_PATH]");

const accepted = loadAcceptedFindings(allowlistPath);
const sarifFiles = targets.flatMap((target) => collectSarifFiles(resolve(target)));
if (!sarifFiles.length) throw new Error("CodeQL security gate received no SARIF files");

const blocked = [];
const acknowledged = [];
for (const file of sarifFiles) {
  const document = readSarif(file);
  for (const run of document.runs || []) inspectRun(run, file, accepted, blocked, acknowledged);
}

for (const finding of acknowledged) {
  process.stderr.write(`accepted CodeQL finding: ${finding.ruleId} at ${finding.path} (${finding.reason}; expires ${finding.expires})\n`);
}
if (blocked.length) {
  for (const finding of blocked.slice(0, 100)) {
    process.stderr.write(`${finding.path}:${finding.line}: ${finding.ruleId}: ${finding.message}\n`);
  }
  if (blocked.length > 100) process.stderr.write(`... ${blocked.length - 100} additional security findings omitted\n`);
  throw new Error(`CodeQL security gate rejected ${blocked.length} unaccepted security finding(s)`);
}
process.stderr.write(`CodeQL security gate ok (${sarifFiles.length} SARIF file(s); ${acknowledged.length} explicitly accepted finding(s))\n`);

function inspectRun(run, file, allowlist, blockedFindings, acceptedFindings) {
  const rules = new Map();
  for (const rule of run.tool?.driver?.rules || []) rules.set(rule.id, rule);
  for (const result of run.results || []) {
    const ruleId = String(result.ruleId || "");
    const rule = rules.get(ruleId) || {};
    if (!isSecurityRule(rule)) continue;
    const location = primaryLocation(result);
    const path = normalizeSarifPath(location.path, run, file);
    const line = Number(location.line) || 1;
    const message = boundedMessage(result.message?.text || result.message?.markdown || rule.shortDescription?.text || "security finding");
    const exception = allowlist.get(`${ruleId}\0${path}`);
    if (exception) acceptedFindings.push({ ruleId, path, ...exception });
    else blockedFindings.push({ ruleId, path, line, message });
  }
}

function isSecurityRule(rule) {
  const properties = rule?.properties || {};
  const tags = Array.isArray(properties.tags) ? properties.tags.map((value) => String(value).toLowerCase()) : [];
  const severity = Number(properties["security-severity"]);
  return tags.includes("security") || (Number.isFinite(severity) && severity > 0);
}

function primaryLocation(result) {
  const physical = result.locations?.[0]?.physicalLocation || {};
  return {
    path: physical.artifactLocation?.uri || "<unknown>",
    line: physical.region?.startLine || 1,
  };
}

function normalizeSarifPath(value, run, sarifFile) {
  let path = String(value || "<unknown>").replaceAll("\\", "/");
  try { path = decodeURIComponent(path); } catch {}
  if (path.startsWith("file://")) path = fileURLToPath(path).replaceAll("\\", "/");
  const baseId = run.originalUriBaseIds?.["%SRCROOT%"]?.uri;
  if (baseId && path.startsWith(String(baseId))) path = path.slice(String(baseId).length);
  if (isAbsolute(path)) {
    const repositoryRelative = relative(root, path).split(sep).join("/");
    path = repositoryRelative === ".." || repositoryRelative.startsWith("../") ? path : repositoryRelative;
  }
  path = path.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path === ".") return `<unknown:${basename(sarifFile)}>`;
  return path;
}

function loadAcceptedFindings(file) {
  let document;
  try { document = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw new Error(`CodeQL accepted-findings file is invalid: ${file}`, { cause: error });
  }
  if (document?.schemaVersion !== 1 || !Array.isArray(document.accepted)) {
    throw new Error("CodeQL accepted-findings file must use schemaVersion 1 and an accepted array");
  }
  const today = new Date().toISOString().slice(0, 10);
  const entries = new Map();
  for (const item of document.accepted) {
    const ruleId = String(item?.ruleId || "");
    const path = String(item?.path || "").replaceAll("\\", "/").replace(/^\.\//, "");
    const reason = String(item?.reason || "").trim();
    const expires = String(item?.expires || "");
    if (!ruleId || !path || reason.length < 40 || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      throw new Error("each accepted CodeQL finding requires ruleId, path, a substantive reason, and YYYY-MM-DD expires");
    }
    if (expires < today) throw new Error(`accepted CodeQL finding expired: ${ruleId} at ${path}`);
    const key = `${ruleId}\0${path}`;
    if (entries.has(key)) throw new Error(`duplicate accepted CodeQL finding: ${ruleId} at ${path}`);
    entries.set(key, { reason, expires });
  }
  return entries;
}

function collectSarifFiles(input) {
  const info = statSync(input);
  if (info.isFile()) return isSarifName(input) ? [input] : [];
  if (!info.isDirectory()) return [];
  const files = [];
  const stack = [input];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && isSarifName(path)) files.push(path);
      if (files.length > 100) throw new Error("CodeQL security gate received more than 100 SARIF files");
    }
  }
  return files.sort();
}

function isSarifName(file) {
  const name = file.toLowerCase();
  return extname(name) === ".sarif" || name.endsWith(".sarif.json");
}

function readSarif(file) {
  const repositoryPath = relative(root, file).split(sep).join("/");
  const bytes = readBoundedRegularFileSync(file, 100 * 1024 * 1024, "SARIF file");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`SARIF file is not valid UTF-8: ${repositoryPath}`); }
  const document = JSON.parse(text);
  if (!Array.isArray(document?.runs)) throw new Error(`invalid SARIF document: ${repositoryPath}`);
  return document;
}

function boundedMessage(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 500);
}
