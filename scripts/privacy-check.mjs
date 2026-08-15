import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { createTrustedGitResolver } from "../src/local/trusted-git-executable.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selfPath = "scripts/privacy-check.mjs";
const gitExecutable = createTrustedGitResolver({ workspace: root });
const requestedOptions = new Set(process.argv.slice(2));
for (const option of requestedOptions) {
  if (option !== "--history") throw new Error(`unknown privacy-check option: ${option}`);
}
const scanHistory = requestedOptions.has("--history");
const candidates = collectCandidateFiles(root);
const denylist = loadDenylist(path.join(root, ".privacy-denylist"));
const findings = [];

for (const relativePath of candidates) {
  if (relativePath === ".privacy-denylist") continue;
  scanDenylistPath(relativePath, denylist, findings);
  scanSensitivePath(relativePath, findings);
  const fullPath = path.join(root, relativePath);
  let buffer;
  try {
    buffer = readBoundedRegularFileSync(fullPath, 5 * 1024 * 1024 + 1);
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || error || "");
    const rule = code === "ELOOP" || /symbolic link/i.test(message)
      ? "symbolic link in publication surface"
      : /exceeds/i.test(message)
        ? "file exceeds privacy scanner size limit and requires manual review"
        : "publication file content could not be read";
    findings.push({ path: relativePath, line: 1, rule });
    continue;
  }
  if (buffer.length > 5 * 1024 * 1024) {
    findings.push({ path: relativePath, line: 1, rule: "file exceeds privacy scanner size limit and requires manual review" });
    continue;
  }
  if (buffer.includes(0)) {
    findings.push({ path: relativePath, line: 1, rule: "binary file in publication surface requires manual review" });
    continue;
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    findings.push({ path: relativePath, line: 1, rule: "non-UTF-8 file in publication surface requires manual review" });
    continue;
  }
  if (relativePath !== selfPath) scanBuiltIn(relativePath, text, findings);
  if (path.basename(relativePath).toLowerCase() === ".npmrc") scanNpmrc(relativePath, text, findings);
  scanDenylist(relativePath, text, denylist, findings);
}

const historySummaryCounts = scanHistory ? scanReachableHistory(root, denylist, findings) : { blobs: 0, commits: 0 };

if (findings.length) {
  for (const finding of findings.slice(0, 100)) {
    process.stderr.write(`${redactReportPath(finding.path, denylist)}:${finding.line}: ${finding.rule}\n`);
  }
  if (findings.length > 100) process.stderr.write(`... ${findings.length - 100} additional findings omitted\n`);
  process.stderr.write("Privacy check failed. Replace private identifiers with synthetic examples or review the local denylist.\n");
  process.exit(1);
}

const historySummary = scanHistory ? `; ${historySummaryCounts.blobs} reachable history blobs; ${historySummaryCounts.commits} commit messages` : "";
process.stderr.write(`privacy check ok (${candidates.length} tracked/unignored files; ${denylist.length} local denylist entries${historySummary})\n`);

function collectCandidateFiles(directory) {
  try {
    const listed = execFileSync(gitExecutable(), ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").split("\0").filter(Boolean);
    const deleted = new Set(execFileSync(gitExecutable(), ["-C", directory, "ls-files", "-z", "--deleted"], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").split("\0").filter(Boolean));
    return listed.filter((relativePath) => !deleted.has(relativePath)).sort();
  } catch {
    const excluded = new Set([".git", ".wrangler", "node_modules"]);
    const files = [];
    const stack = [""];
    while (stack.length) {
      const relative = stack.pop();
      const absolute = path.join(directory, relative);
      let entries;
      try { entries = readdirSync(absolute, { withFileTypes: true }); } catch {
        throw new Error("privacy fallback traversal could not read a repository directory");
      }
      for (const entry of entries) {
        if (excluded.has(entry.name) || entry.name === ".privacy-denylist") continue;
        const child = relative ? path.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile() || entry.isSymbolicLink()) files.push(child.split(path.sep).join("/"));
      }
    }
    return files.sort();
  }
}

function scanReachableHistory(directory, entries, out) {
  let listing;
  try {
    listing = execFileSync(gitExecutable(), ["-C", directory, "rev-list", "--objects", "--all", "-z"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("privacy history scan could not enumerate reachable Git objects");
  }
  let records;
  try { records = new TextDecoder("utf-8", { fatal: true }).decode(listing).split("\0").filter(Boolean); }
  catch { throw new Error("privacy history scan encountered a non-UTF-8 Git object path"); }
  const objectPaths = new Map();
  let objectHash = "";
  for (const record of records) {
    if (/^[0-9a-f]{40,64}$/.test(record)) {
      objectHash = record;
      continue;
    }
    if (!record.startsWith("path=") || !objectHash) {
      objectHash = "";
      continue;
    }
    const relativePath = record.slice(5);
    if (relativePath && !relativePath.includes("\0")) {
      if (!objectPaths.has(objectHash)) objectPaths.set(objectHash, new Set());
      objectPaths.get(objectHash).add(relativePath);
    }
    objectHash = "";
  }
  const hashes = [...objectPaths.keys()];
  let metadata;
  try {
    metadata = execFileSync(gitExecutable(), ["-C", directory, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      input: `${hashes.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split(/\r?\n/);
  } catch {
    throw new Error("privacy history scan could not classify reachable Git objects");
  }
  const blobSizes = new Map();
  for (const line of metadata) {
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(line);
    if (match) blobSizes.set(match[1], Number(match[2]));
  }
  let scanned = 0;
  for (const [hash, paths] of objectPaths) {
    if (!blobSizes.has(hash)) continue;
    const relativePaths = [...paths].sort();
    const reportPath = relativePaths[0] || "unknown";
    const contentPath = relativePaths.find((relativePath) => relativePath !== selfPath) || reportPath;
    for (const relativePath of relativePaths) {
      if (relativePath === ".privacy-denylist") continue;
      const historicalPath = `history/${hash.slice(0, 12)}/${relativePath}`;
      scanDenylistPath(historicalPath, entries, out);
      scanSensitivePath(historicalPath, out);
    }
    if (blobSizes.get(hash) > 5 * 1024 * 1024) {
      out.push({ path: `history/${hash.slice(0, 12)}/${reportPath}`, line: 1, rule: "historical file exceeds privacy scanner size limit and requires manual review" });
      continue;
    }
    let buffer;
    try {
      buffer = execFileSync(gitExecutable(), ["-C", directory, "cat-file", "blob", hash], {
        encoding: "buffer",
        maxBuffer: 6 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      out.push({ path: `history/${hash.slice(0, 12)}/${reportPath}`, line: 1, rule: "historical file content could not be read" });
      continue;
    }
    scanned += 1;
    const historicalPath = `history/${hash.slice(0, 12)}/${contentPath}`;
    if (buffer.includes(0)) {
      out.push({ path: historicalPath, line: 1, rule: "binary file in reachable Git history requires manual review" });
      continue;
    }
    let historicalText;
    try { historicalText = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch {
      out.push({ path: historicalPath, line: 1, rule: "non-UTF-8 file in reachable Git history requires manual review" });
      continue;
    }
    if (contentPath !== selfPath) scanBuiltIn(historicalPath, historicalText, out);
    if (relativePaths.some((relativePath) => path.basename(relativePath).toLowerCase() === ".npmrc")) scanNpmrc(historicalPath, historicalText, out);
    scanDenylist(historicalPath, historicalText, entries, out);
  }
  const commitCount = scanReachableCommitMessages(directory, entries, out);
  return { blobs: scanned, commits: commitCount };
}

function scanReachableCommitMessages(directory, entries, out) {
  let output;
  try {
    output = execFileSync(gitExecutable(), ["-C", directory, "log", "--all", "--format=%H%x00%B%x00"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("privacy history scan could not read reachable commit messages");
  }
  let records;
  try { records = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0"); }
  catch { throw new Error("privacy history scan encountered a non-UTF-8 commit message"); }
  let count = 0;
  for (let index = 0; index + 1 < records.length; index += 2) {
    const hash = records[index].trim();
    const message = records[index + 1];
    if (!/^[0-9a-f]{40,64}$/.test(hash)) continue;
    const reportPath = `history/commit/${hash.slice(0, 12)}/message`;
    const scannedMessage = removeKnownPublicAutomationTrailers(message);
    scanBuiltIn(reportPath, scannedMessage, out);
    scanDenylist(reportPath, scannedMessage, entries, out);
    count += 1;
  }
  return count;
}

function removeKnownPublicAutomationTrailers(message) {
  return String(message).split(/\r?\n/).filter((line) => {
    return !/^(?:Signed-off-by|Co-authored-by):\s+dependabot\[bot\]\s+<[^>\s]+@github\.com>\s*$/i.test(line);
  }).join("\n");
}

function redactReportPath(relativePath, entries) {
  let shown = String(relativePath);
  for (const entry of entries) {
    const expression = new RegExp(escapeRegExp(entry), "gi");
    shown = shown.replace(expression, "<private>");
  }
  return shown;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanBuiltIn(relativePath, text, out) {
  const rules = [
    ["private key material", /-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g],
    ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["GitHub access token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g],
    ["GitLab access token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
    ["npm access token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
    ["Slack access token", /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g],
    ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
    ["live payment API key", /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g],
    ["API secret token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
    ["JWT-like bearer token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
    ["absolute macOS/Linux home path", /(?:^|[\s"'=(:,])\/(?:Users|home)\/([^/\s"'<>]+)\//gm],
    ["absolute Windows home path", /(?:^|[\s"'=(:,])\b[A-Za-z]:\\Users\\([^\\\s"'<>]+)\\/gm],
  ];
  for (const [rule, expression] of rules) {
    for (const match of text.matchAll(expression)) {
      if (rule.includes("home path") && isSyntheticUser(String(match[1] || ""))) continue;
      out.push({ path: relativePath, line: lineNumber(text, match.index || 0), rule });
    }
  }
  const credentialUrl = /https?:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@([^\s/"'<>]+)/gi;
  for (const match of text.matchAll(credentialUrl)) {
    if (isReservedExampleHost(stripHostPort(match[1]))) continue;
    out.push({ path: relativePath, line: lineNumber(text, match.index || 0), rule: "URL with embedded credentials" });
  }
  const emailLike = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (const match of text.matchAll(emailLike)) {
    if (isReservedExampleHost(match[1]) || String(match[1]).toLowerCase().endsWith(".noreply.github.com")) continue;
    out.push({ path: relativePath, line: lineNumber(text, match.index || 0), rule: "non-example email address" });
  }
  const sshLike = /\b[A-Za-z_][A-Za-z0-9._-]*@([A-Za-z0-9.-]+)\b/g;
  for (const match of text.matchAll(sshLike)) {
    if (isReservedExampleHost(match[1]) || !hasNearbySshContext(text, match.index || 0)) continue;
    out.push({ path: relativePath, line: lineNumber(text, match.index || 0), rule: "non-example SSH user@host identifier" });
  }
}


function scanSensitivePath(relativePath, out) {
  const normalized = String(relativePath).split(path.sep).join("/");
  const base = path.posix.basename(normalized).toLowerCase();
  const sensitive = base === ".dev.vars"
    || /^\.env(?:\.|$)/.test(base)
    || /\.(?:pem|p12|pfx|sqlite|sqlite3|db|log)$/i.test(base)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base)
    || /^(?:credentials?|secrets?|cookies?|sessions?|tokens?)(?:\.|$)/i.test(base);
  if (sensitive) out.push({ path: relativePath, line: 1, rule: "credential- or private-data-shaped publication filename" });
}

function scanNpmrc(relativePath, text, out) {
  const forbiddenKey = /(?:^|:)(?:_auth|_authtoken|_password|username|email|certfile|keyfile|cafile)$/i;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) {
      out.push({ path: relativePath, line: index + 1, rule: "unparseable tracked .npmrc line requires manual review" });
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (forbiddenKey.test(key) || /(?:^|[:/])(?:_auth|_authtoken|_password|username|email|certfile|keyfile|cafile)$/i.test(key)) {
      out.push({ path: relativePath, line: index + 1, rule: "tracked .npmrc contains authentication or identity configuration" });
    }
    if (/\$\{[^}]+\}/.test(value) || /https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(value)) {
      out.push({ path: relativePath, line: index + 1, rule: "tracked .npmrc contains environment interpolation or embedded credentials" });
    }
  }
}

function scanDenylistPath(relativePath, entries, out) {
  const lower = relativePath.toLocaleLowerCase("en-US");
  for (const entry of entries) {
    if (lower.includes(entry)) out.push({ path: relativePath, line: 1, rule: "local private-identifier denylist match in file path" });
  }
}

function scanDenylist(relativePath, text, entries, out) {
  const lower = text.toLocaleLowerCase("en-US");
  for (const entry of entries) {
    let offset = 0;
    while ((offset = lower.indexOf(entry, offset)) !== -1) {
      out.push({ path: relativePath, line: lineNumber(text, offset), rule: "local private-identifier denylist match" });
      offset += Math.max(1, entry.length);
    }
  }
}

function loadDenylist(file) {
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, "utf8"); } catch {
    throw new Error("local privacy denylist exists but could not be read");
  }
  return [...new Set(text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.length >= 3)
    .map((line) => line.toLocaleLowerCase("en-US")))];
}

function isSyntheticUser(value) {
  return /^(?:user|username|example|test|name|home|runner|workspace|tmp|private|path|package)$/i.test(value)
    || /^<[^>]+>$/.test(value);
}

function hasNearbySshContext(text, offset) {
  const lineStart = Math.max(0, text.lastIndexOf("\n", offset - 1));
  let start = lineStart;
  for (let count = 0; count < 4 && start > 0; count += 1) start = Math.max(0, text.lastIndexOf("\n", start - 1));
  let end = offset;
  for (let count = 0; count < 4 && end < text.length; count += 1) {
    const next = text.indexOf("\n", end + 1);
    end = next === -1 ? text.length : next;
  }
  return /\b(?:ssh|scp|sftp)\b/i.test(text.slice(start, end));
}

function stripHostPort(host) {
  const value = String(host || "");
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]") > 0 ? value.indexOf("]") : undefined);
  return value.replace(/:[0-9]+$/, "");
}

function isReservedExampleHost(host) {
  const value = String(host || "").toLowerCase().replace(/\.$/, "");
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || value === "example"
    || value === "example.com"
    || value === "example.net"
    || value === "example.org"
    || value.endsWith(".example")
    || value.endsWith(".example.com")
    || value.endsWith(".example.net")
    || value.endsWith(".example.org")
    || value.endsWith(".invalid");
}

function lineNumber(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}
