import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeMarkdownTableCell, normalizeLineEndings } from "../scripts/markdown.mjs";

assert.equal(escapeMarkdownTableCell("plain"), "plain");
assert.equal(escapeMarkdownTableCell("a|b"), "a\\|b");
assert.equal(escapeMarkdownTableCell("a\\b|c"), "a\\\\b\\|c");
assert.equal(normalizeLineEndings("a\r\nb\r\n"), "a\nb\n");

// Documentation consistency & internal link validity checks
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = join(root, "docs");
const docFiles = readdirSync(docsDir).filter((name) => name.endsWith(".md")).map((name) => join(docsDir, name));
const rootDocs = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "AGENTS.md"]
  .map((name) => join(root, name))
  .filter((file) => existsSync(file));

const allDocs = [...docFiles, ...rootDocs];
let totalLinksChecked = 0;

for (const file of allDocs) {
  const content = readFileSync(file, "utf8");
  assert(content.length > 0, `empty documentation file: ${relative(root, file)}`);
  assert(content.endsWith("\n"), `documentation file missing trailing newline: ${relative(root, file)}`);
  if (process.platform !== "win32") {
    assert(!content.includes("\r"), `documentation file contains CRLF: ${relative(root, file)}`);
  }

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim();
    if (!rawTarget || rawTarget.startsWith("#") || rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("mailto:")) {
      continue;
    }
    const pathPart = rawTarget.split("#")[0];
    if (!pathPart) continue;
    const resolvedPath = resolve(dirname(file), pathPart);
    assert(existsSync(resolvedPath), `broken documentation link in ${relative(root, file)}: ${rawTarget} -> ${relative(root, resolvedPath)}`);
    totalLinksChecked += 1;
  }
}

console.log(`documentation consistency check ok (${allDocs.length} files, ${totalLinksChecked} internal links verified)`);
console.log("markdown helper test ok");
