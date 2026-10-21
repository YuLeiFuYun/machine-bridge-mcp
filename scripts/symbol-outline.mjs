#!/usr/bin/env node
// @ts-check
import { resolve } from "node:path";
import { extractSymbolOutline, extractWorkspaceOutline } from "../src/local/symbol-outline.mjs";

function parseArgs(args) {
  let target = ".";
  let maxFiles = 50;
  let maxLines = 500;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--max-files=")) {
      maxFiles = Number.parseInt(arg.slice("--max-files=".length), 10);
    } else if (arg.startsWith("--max-lines=")) {
      maxLines = Number.parseInt(arg.slice("--max-lines=".length), 10);
    } else if (!arg.startsWith("-")) {
      target = arg;
    }
  }

  return { target, maxFiles, maxLines, json };
}

const { target, maxFiles, maxLines, json } = parseArgs(process.argv.slice(2));
const fullPath = resolve(process.cwd(), target);

if (json) {
  const result = await extractWorkspaceOutline(fullPath, { maxFiles, maxLines });
  console.log(JSON.stringify(result, null, 2));
} else {
  const outline = await extractSymbolOutline(fullPath, { maxFiles, maxLines });
  console.log(outline);
}
