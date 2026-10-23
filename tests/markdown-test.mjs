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
const docFiles = walkMarkdown(docsDir);
const rootDocs = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "AGENTS.md"]
  .map((name) => join(root, name))
  .filter((file) => existsSync(file));

const allDocs = [...docFiles, ...rootDocs];
const headingSlugs = new Map(allDocs.map((file) => [file, headingSlugsFor(readFileSync(file, "utf8"))]));
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
    const [rawPath, rawFragment] = rawTarget.split("#", 2);
    if (!rawPath) continue;
    const resolvedPath = resolve(dirname(file), decodeURI(rawPath));
    assert(existsSync(resolvedPath), `broken documentation link in ${relative(root, file)}: ${rawTarget} -> ${relative(root, resolvedPath)}`);
    if (rawFragment && resolvedPath.endsWith(".md")) {
      const slugs = headingSlugs.get(resolvedPath) || headingSlugsFor(readFileSync(resolvedPath, "utf8"));
      assert(slugs.has(decodeURIComponent(rawFragment)), `broken documentation anchor in ${relative(root, file)}: ${rawTarget}`);
    }
    totalLinksChecked += 1;
  }
}

function walkMarkdown(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? walkMarkdown(join(directory, entry.name))
      : entry.name.endsWith(".md") ? [join(directory, entry.name)] : [])
    .sort();
}

function headingSlugsFor(content) {
  const slugs = new Set();
  for (const line of content.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const slug = match[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-");
    if (slug) slugs.add(slug);
  }
  return slugs;
}

console.log(`documentation consistency check ok (${allDocs.length} files, ${totalLinksChecked} internal links and anchors verified)`);
console.log("markdown helper test ok");
