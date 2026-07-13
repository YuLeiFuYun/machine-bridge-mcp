import assert from "node:assert/strict";
import { escapeMarkdownTableCell, normalizeLineEndings } from "../scripts/markdown.mjs";

assert.equal(escapeMarkdownTableCell("plain"), "plain");
assert.equal(escapeMarkdownTableCell("a|b"), "a\\|b");
assert.equal(escapeMarkdownTableCell("a\\b|c"), "a\\\\b\\|c");
assert.equal(normalizeLineEndings("a\r\nb\r\n"), "a\nb\n");
console.log("markdown helper test ok");
