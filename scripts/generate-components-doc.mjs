import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeLineEndings } from "./lib/verification.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const targetPath = join(root, "docs", "architecture", "components.md");

const LOCAL_DOMAIN_PURPOSES = new Map([
  ["core", "Policy evaluation, operation risk/reversibility, errors, timing, exclusive files, filesystem identity, and logging primitives."],
  ["state", "Workspace state persistence, multi-account access control, device-root identity, locking, and OAuth/Worker secret storage."],
  ["transport", "WebSocket relay connection lifecycle, liveness/heartbeat monitoring, HTTP fallback, call recovery, proxy selection, and stdio transport."],
  ["files", "Canonical workspace path containment, file search, bounded reads/writes, transactional patches, and workspace checkpoints."],
  ["git", "Structured Git status/diff/log/show inspection, plumbing, and staged commits."],
  ["process", "Argv execution contracts, settlement classification, tree signals/supervision, interactive sessions, and resource admission."],
  ["jobs", "Detached managed-job plans, dependency waits, lock/directory persistence, resource/worktree isolation, runners, and retention."],
  ["automation", "Loopback browser broker, pairing, extension protocol/operations, desktop AppKit/JXA automation, and Computer Use snapshots."],
  ["agent", "Project AGENTS/skill/command discovery, capability ranking, routing, symbol outlines, and bounded context projections."],
  ["deploy", "Hardened npm wrapper, Cloudflare project/Worker deployment, platform autostart services, and platform shell helpers."],
  ["runtime", "LocalRuntime orchestrator, tool-executor pipeline, loop/taint detection, observability metrics, diagnostics, and SHA-256 audit log."],
  ["cli", "Top-level CLI command dispatch, argument parsing, verify/pair admin actions, idle-sleep control, and account management."],
]);

const WORKER_DOMAIN_PURPOSES = new Map([
  ["mcp", "MCP HTTP contract, JSON-RPC framing, tool catalog projection, SSE response proxy, and Jobs UI Monitor integration."],
  ["oauth", "OAuth 2.1/PKCE controller, client registration, DPoP proof verification, sharded token issuance, and account administration."],
  ["daemon", "Connected daemon registry, channel readiness probing, ready waiters, and Worker-side continuity evidence."],
  ["room", "BridgeRoom Durable Object fetch/alarm routing, pending-call lifecycle, policy enforcement, and server_info projections."],
]);

function walkFiles(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out.sort();
}

function summarizeFile(fullPath) {
  const rel = relative(root, fullPath).split("\\").join("/");
  const text = readFileSync(fullPath, "utf8");
  const lines = text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
  const tsCheck = /^\/\/\s*@ts-check\b/m.test(text);
  const directExports = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+([A-Za-z_$][\w$]*)/gm)].length;
  let reExports = 0;
  for (const match of text.matchAll(/^export\s+\{([^}]+)\}/gm)) {
    reExports += match[1].split(",").map((part) => part.trim()).filter(Boolean).length;
  }
  return { rel, lines, tsCheck, exports: directExports + reExports };
}

function groupByDomain(files, basePrefix) {
  const groups = new Map();
  for (const file of files) {
    const sub = file.rel.slice(basePrefix.length);
    const slash = sub.indexOf("/");
    const domain = slash >= 0 ? sub.slice(0, slash) : "(root)";
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(file);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderTable(entries, { showTsCheck = false } = {}) {
  const lines = [
    showTsCheck
      ? "| Module | Lines | `@ts-check` | Exports |"
      : "| Module | Lines | Exports |",
    showTsCheck
      ? "|---|---:|---:|---:|"
      : "|---|---:|---:|",
  ];
  for (const entry of entries) {
    lines.push(showTsCheck
      ? `| \`${entry.rel}\` | ${entry.lines} | ${entry.tsCheck ? "yes" : "no"} | ${entry.exports} |`
      : `| \`${entry.rel}\` | ${entry.lines} | ${entry.exports} |`);
  }
  return lines;
}

function renderComponentsDoc() {
  const localFiles = walkFiles(join(root, "src", "local"), [".mjs"]).map(summarizeFile);
  const workerFiles = walkFiles(join(root, "src", "worker"), [".ts"]).map(summarizeFile);
  const sharedFiles = walkFiles(join(root, "src", "shared"), [".mjs", ".json"]).map(summarizeFile);
  const extensionFiles = walkFiles(join(root, "browser-extension"), [".js", ".json", ".html"]).map(summarizeFile);
  const binFiles = walkFiles(join(root, "bin"), [".mjs"]).map(summarizeFile);

  const lines = [
    "# Component reference",
    "",
    "> Generated from repository source layout. Do not edit manually; run `npm run components-doc:generate`.",
    "",
    "See [Architecture](../ARCHITECTURE.md) for trust boundaries, request lifecycle, and module DAG rules enforced by `tests/architecture/module-boundaries.mjs`.",
    "",
    "## Summary",
    "",
    "| Area | Files | Source location |",
    "|---|---:|---|",
    `| Local daemon domains | ${localFiles.length} | \`src/local/\` |`,
    `| Cloudflare Worker domains | ${workerFiles.length} | \`src/worker/\` |`,
    `| Shared contracts and protocol | ${sharedFiles.length} | \`src/shared/\` |`,
    `| Packaged Chromium extension | ${extensionFiles.length} | \`browser-extension/\` |`,
    `| CLI entrypoints | ${binFiles.length} | \`bin/\` |`,
    "",
    "## Shared contracts (`src/shared/`)",
    "",
    ...renderTable(sharedFiles, { showTsCheck: true }),
    "",
    "## Local runtime domains (`src/local/`)",
    "",
  ];

  for (const [domain, files] of groupByDomain(localFiles, "src/local/")) {
    const purpose = LOCAL_DOMAIN_PURPOSES.get(domain) || "Local domain modules.";
    lines.push(`### \`src/local/${domain}/\` (${files.length} files)`, "", purpose, "", ...renderTable(files, { showTsCheck: true }), "");
  }

  lines.push("## Cloudflare Worker domains (`src/worker/`)", "");
  for (const [domain, files] of groupByDomain(workerFiles, "src/worker/")) {
    const heading = domain === "(root)" ? "`src/worker/index.ts`" : `\`src/worker/${domain}/\``;
    const purpose = WORKER_DOMAIN_PURPOSES.get(domain) || "Worker Durable Object entrypoint and bindings.";
    lines.push(`### ${heading} (${files.length} files)`, "", purpose, "", ...renderTable(files), "");
  }

  lines.push(
    "## Browser extension (`browser-extension/`)",
    "",
    ...renderTable(extensionFiles),
    "",
    "## CLI entrypoints (`bin/`)",
    "",
    ...renderTable(binFiles),
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

const generated = renderComponentsDoc();
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(targetPath, "utf8"); } catch { /* missing triggers check error */ }
  if (normalizeLineEndings(current) !== generated) {
    console.error("docs/architecture/components.md is stale; run npm run components-doc:generate");
    process.exitCode = 1;
  } else {
    console.log("component reference is up to date");
  }
} else {
  writeFileSync(targetPath, generated, "utf8");
  console.log("generated docs/architecture/components.md");
}
