import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeLineEndings } from "./lib/verification.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const targetPath = join(root, "src", "shared", "help-resources-content.json");

const HELP_RESOURCE_SOURCES = Object.freeze([
  ["machine-bridge://help/managed-jobs", "docs/help/managed-jobs.md"],
  ["machine-bridge://help/diagnostics-and-relay", "docs/help/diagnostics-and-relay.md"],
  ["machine-bridge://help/browser-and-apps", "docs/help/browser-and-apps.md"],
  ["machine-bridge://help/security-and-authority", "docs/help/security-and-authority.md"],
]);

function renderHelpResourcesContent() {
  const map = Object.create(null);
  for (const [uri, relPath] of HELP_RESOURCE_SOURCES) {
    const raw = readFileSync(join(root, relPath), "utf8");
    const content = normalizeLineEndings(raw).trim();
    if (!content) throw new Error(`help resource document is empty: ${relPath}`);
    map[uri] = content;
  }
  return `${JSON.stringify(map, null, 2)}\n`;
}

const generated = renderHelpResourcesContent();
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(targetPath, "utf8"); } catch { /* missing triggers check error */ }
  if (normalizeLineEndings(current) !== generated) {
    console.error("src/shared/help-resources-content.json is stale; run npm run help-resources:generate");
    process.exitCode = 1;
  } else {
    console.log(`help resources content is up to date (${HELP_RESOURCE_SOURCES.length} resources)`);
  }
} else {
  writeFileSync(targetPath, generated, "utf8");
  console.log(`generated src/shared/help-resources-content.json (${HELP_RESOURCE_SOURCES.length} resources)`);
}
