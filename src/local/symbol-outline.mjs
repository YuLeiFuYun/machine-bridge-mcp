// @ts-check
import { lstat, opendir, realpath } from "node:fs/promises";
import { readRegularUtf8 } from "./agent-text-file.mjs";
import { isContainedPath } from "./agent-contract.mjs";
import { extname, join, relative } from "node:path";

const DEFAULT_IGNORED_DIRS = Object.freeze(new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".wrangler",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv",
]));

const SUPPORTED_EXTENSIONS = Object.freeze(new Set([
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx",
]));

const REGEX_PRECEDING_TOKENS = Object.freeze(new Set([
  "(", "[", "{", ";", ",", ":", "?", "=", "!", "&", "|", "^", "~", "+", "-", "*", "%", "<", ">", "/",
]));

const REGEX_PRECEDING_KEYWORDS = Object.freeze(new Set([
  "return", "case", "typeof", "delete", "void", "throw", "instanceof", "in", "of", "yield", "await", "default",
]));

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @returns {number}
 */
function skipLineComment(code, len, startIdx, out) {
  out.text += "  ";
  let idx = startIdx + 2;
  while (idx < len && code[idx] !== "\n") {
    out.text += " ";
    idx++;
  }
  if (idx < len && code[idx] === "\n") {
    out.text += "\n";
    idx++;
  }
  return idx;
}

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @returns {number}
 */
function skipBlockComment(code, len, startIdx, out) {
  out.text += "  ";
  let idx = startIdx + 2;
  while (idx < len && !(code[idx] === "*" && code[idx + 1] === "/")) {
    out.text += code[idx] === "\n" ? "\n" : " ";
    idx++;
  }
  if (idx < len) {
    out.text += "  ";
    idx += 2;
  }
  return idx;
}

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @param {string} quote
 * @returns {number}
 */
function skipStringLiteral(code, len, startIdx, out, quote) {
  out.text += " ";
  let idx = startIdx + 1;
  while (idx < len && code[idx] !== quote && code[idx] !== "\n") {
    if (code[idx] === "\\") {
      out.text += "  ";
      idx += 2;
    } else {
      out.text += " ";
      idx++;
    }
  }
  if (idx < len && code[idx] === quote) {
    out.text += " ";
    idx++;
  }
  return idx;
}

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @returns {number}
 */
function skipRegexLiteral(code, len, startIdx, out) {
  out.text += " ";
  let idx = startIdx + 1;
  let inClass = false;
  while (idx < len) {
    const c = code[idx];
    if (c === "\n") {
      out.text += "\n";
      idx++;
      break;
    }
    if (c === "\\") {
      out.text += "  ";
      idx += 2;
      continue;
    }
    if (c === "[" && !inClass) {
      inClass = true;
      out.text += " ";
      idx++;
      continue;
    }
    if (c === "]" && inClass) {
      inClass = false;
      out.text += " ";
      idx++;
      continue;
    }
    if (c === "/" && !inClass) {
      out.text += " ";
      idx++;
      while (idx < len && /[a-z]/i.test(code[idx])) {
        out.text += " ";
        idx++;
      }
      break;
    }
    out.text += " ";
    idx++;
  }
  return idx;
}

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @returns {number}
 */
function sanitizeTemplate(code, len, startIdx, out) {
  out.text += " ";
  let idx = startIdx + 1;
  while (idx < len) {
    const c = code[idx];
    if (c === "`") {
      out.text += " ";
      return idx + 1;
    }
    if (c === "\\") {
      out.text += code[idx + 1] === "\n" ? " \n" : "  ";
      idx += 2;
      continue;
    }
    if (c === "$" && code[idx + 1] === "{") {
      out.text += "  ";
      idx = sanitizeTemplateExpr(code, len, idx + 2, out);
      continue;
    }
    out.text += c === "\n" ? "\n" : " ";
    idx++;
  }
  return idx;
}

/**
 * @param {string} code
 * @param {number} len
 * @param {number} startIdx
 * @param {{ text: string }} out
 * @returns {number}
 */
function sanitizeTemplateExpr(code, len, startIdx, out) {
  let idx = startIdx;
  let braceDepth = 1;
  let exprLastChar = "{";
  let exprLastToken = "";

  while (idx < len && braceDepth > 0) {
    const c = code[idx];
    const nextC = code[idx + 1];

    if (c === "/" && nextC === "/") {
      idx = skipLineComment(code, len, idx, out);
      exprLastChar = ";";
      exprLastToken = "";
      continue;
    }
    if (c === "/" && nextC === "*") {
      idx = skipBlockComment(code, len, idx, out);
      continue;
    }
    if (c === '"' || c === "'") {
      idx = skipStringLiteral(code, len, idx, out, c);
      exprLastChar = ")";
      exprLastToken = "";
      continue;
    }
    if (c === "`") {
      idx = sanitizeTemplate(code, len, idx, out);
      exprLastChar = ")";
      exprLastToken = "";
      continue;
    }
    if (c === "/") {
      const isRegex = REGEX_PRECEDING_TOKENS.has(exprLastChar) || REGEX_PRECEDING_KEYWORDS.has(exprLastToken) || exprLastChar === "";
      if (isRegex) {
        idx = skipRegexLiteral(code, len, idx, out);
        exprLastChar = ")";
        exprLastToken = "";
        continue;
      }
    }
    if (c === "{") {
      braceDepth++;
      out.text += " ";
      exprLastChar = "{";
      exprLastToken = "";
      idx++;
      continue;
    }
    if (c === "}") {
      braceDepth--;
      out.text += " ";
      idx++;
      if (braceDepth === 0) return idx;
      exprLastChar = "}";
      exprLastToken = "";
      continue;
    }

    out.text += c === "\n" ? "\n" : " ";
    if (!/\s/.test(c)) {
      exprLastChar = c;
      if (/[a-zA-Z0-9_$]/.test(c)) exprLastToken += c;
      else exprLastToken = "";
    } else {
      exprLastToken = "";
    }
    idx++;
  }
  return idx;
}

/**
 * Strips comments, string literals, template literal bodies, and regex literals from source code
 * while strictly preserving all newline positions (\n) and column alignments.
 *
 * @param {string} code
 * @returns {string}
 */
export function sanitizeSource(code) {
  const out = { text: "" };
  const len = code.length;
  let i = 0;
  let lastToken = "";
  let lastChar = "";

  while (i < len) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      i = skipLineComment(code, len, i, out);
      lastChar = ";";
      lastToken = "";
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(code, len, i, out);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(code, len, i, out, ch);
      lastChar = ")";
      lastToken = "";
      continue;
    }
    if (ch === "`") {
      i = sanitizeTemplate(code, len, i, out);
      lastChar = ")";
      lastToken = "";
      continue;
    }
    if (ch === "/") {
      const isRegex = REGEX_PRECEDING_TOKENS.has(lastChar) || REGEX_PRECEDING_KEYWORDS.has(lastToken) || lastChar === "";
      if (isRegex) {
        i = skipRegexLiteral(code, len, i, out);
        lastChar = ")";
        lastToken = "";
        continue;
      }
    }

    out.text += ch;
    if (!/\s/.test(ch)) {
      lastChar = ch;
      if (/[a-zA-Z0-9_$]/.test(ch)) lastToken += ch;
      else lastToken = "";
    } else {
      lastToken = "";
    }
    i++;
  }

  return out.text;
}

/**
 * Extracts top-level symbols and class methods from JS/TS source code without native dependencies.
 *
 * @param {string} code
 * @param {string} [filename="anonymous.js"]
 * @param {{ includeInternal?: boolean }} [options={}]
 * @returns {{ file: string, totalLines: number, symbols: Array<any> }}
 */
export function extractFileSymbols(code, filename = "anonymous.js", options = {}) {
  const sanitized = sanitizeSource(code);
  const lines = sanitized.split("\n");
  const origLines = code.split("\n");
  const totalLines = lines.length;
  /** @type {Array<any>} */
  const symbols = [];
  /** @type {{ name: string, kind: string, line: number, superClass: string | null, isExported: boolean, methods: Array<any> } | null} */
  let currentClass = null;
  let braceDepth = 0;
  let classDepth = -1;

  for (let idx = 0; idx < totalLines; idx++) {
    const lineNum = idx + 1;
    let line = lines[idx];
    let trimmed = line.trim();
    let origLine = origLines[idx];

    if ((trimmed.startsWith("function ") || trimmed.startsWith("async function ") || trimmed.startsWith("export ") || (currentClass && braceDepth === classDepth)) && trimmed.includes("(") && !trimmed.includes(")")) {
      let lookAhead = idx;
      while (!line.includes(")") && lookAhead < totalLines - 1 && lookAhead < idx + 12) {
        lookAhead++;
        line += " " + lines[lookAhead].trim();
        origLine += " " + origLines[lookAhead].trim();
      }
      trimmed = line.trim();
    }
    const origTrimmed = origLine.trim();

    if (braceDepth === 0) {
      const classMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?(?:\s+extends\s+([A-Za-z0-9_$.<>\s]+))?/);
      if (classMatch) {
        const origClassMatch = origTrimmed.match(/^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?(?:\s+extends\s+([A-Za-z0-9_$.<>\s]+))?/);
        currentClass = {
          name: classMatch[1],
          kind: "class",
          line: lineNum,
          superClass: (origClassMatch ? origClassMatch[2] : classMatch[2])?.trim() || null,
          isExported: trimmed.startsWith("export"),
          methods: [],
        };
        symbols.push(currentClass);
        classDepth = braceDepth + 1;
      }

      const fnMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(async\s+)?function(?:\s*\*|\s+)?(?:\s+([A-Za-z0-9_$]+))?(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (fnMatch) {
        const origFnMatch = origTrimmed.match(/^(?:export\s+(?:default\s+)?)?(async\s+)?function(?:\s*\*|\s+)?(?:\s+([A-Za-z0-9_$]+))?(?:<[^>]*>)?\s*\(([^)]*)\)/);
        const params = (origFnMatch ? origFnMatch[3] : fnMatch[3]).replace(/\s+/g, " ").trim();
        symbols.push({
          name: fnMatch[2] || "(anonymous)",
          kind: "function",
          line: lineNum,
          async: Boolean(fnMatch[1]),
          params,
          isExported: trimmed.startsWith("export"),
        });
      }

      const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*=>/);
      if (arrowMatch) {
        const origArrowMatch = origTrimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*=>/);
        const params = (origArrowMatch ? (origArrowMatch[3] || origArrowMatch[4]) : (arrowMatch[3] || arrowMatch[4]) || "").replace(/\s+/g, " ").trim();
        symbols.push({
          name: arrowMatch[1],
          kind: "function",
          line: lineNum,
          async: Boolean(arrowMatch[2]),
          params,
          isExported: trimmed.startsWith("export"),
        });
      }

      const tsMatch = trimmed.match(/^(?:export\s+)?(interface|type|enum)\s+([A-Za-z0-9_$]+)/);
      if (tsMatch) {
        symbols.push({
          name: tsMatch[2],
          kind: tsMatch[1],
          line: lineNum,
          isExported: trimmed.startsWith("export"),
        });
      }

      const exportConstMatch = trimmed.match(/^export\s+(?:const|let)\s+([A-Za-z0-9_$]+)\b(?!\s*=\s*(?:async\s*)?\()/);
      if (exportConstMatch && !arrowMatch) {
        symbols.push({
          name: exportConstMatch[1],
          kind: "constant",
          line: lineNum,
          isExported: true,
        });
      }
    } else if (currentClass && braceDepth === classDepth) {
      const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\*|get\s+|set\s+)?(#?[A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (methodMatch && !["if", "for", "while", "switch", "catch", "return"].includes(methodMatch[4])) {
        const origMethodMatch = origTrimmed.match(/^(?:public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\*|get\s+|set\s+)?(#?[A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
        const params = (origMethodMatch ? origMethodMatch[5] : methodMatch[5]).replace(/\s+/g, " ").trim();
        currentClass.methods.push({
          name: methodMatch[4],
          kind: methodMatch[4] === "constructor" ? "constructor" : "method",
          static: Boolean(methodMatch[1]),
          async: Boolean(methodMatch[2]),
          accessor: methodMatch[3]?.trim() || null,
          params,
          line: lineNum,
        });
      }
    }

    const openBraces = (lines[idx].match(/\{/g) || []).length;
    const closeBraces = (lines[idx].match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;
    if (currentClass && braceDepth < classDepth) {
      currentClass = null;
      classDepth = -1;
    }
  }

  return {
    file: filename,
    totalLines,
    symbols: options.includeInternal ? symbols : symbols.filter((s) => s.isExported || s.kind === "class" || s.kind === "interface"),
  };
}

/**
 * Formats structured file symbols into a concise, human-and-agent-readable Repo Map text outline.
 *
 * @param {{ file: string, totalLines: number, symbols: Array<any> }} fileSymbols
 * @param {{ showLineNumbers?: boolean, maxParamLength?: number }} [options={}]
 * @returns {string}
 */
export function renderSymbolOutline(fileSymbols, options = {}) {
  const { showLineNumbers = true, maxParamLength = 60 } = options;
  const lines = [];
  const header = `${fileSymbols.file} (${fileSymbols.totalLines} lines, ${fileSymbols.symbols.length} symbols):`;
  lines.push(header);

  for (const sym of fileSymbols.symbols) {
    const pad = showLineNumbers ? String(sym.line).padStart(5, " ") + ": " : "  ";
    const exportPrefix = sym.isExported ? "export " : "";
    let signature = "";

    if (sym.kind === "class") {
      const ext = sym.superClass ? ` extends ${sym.superClass}` : "";
      signature = `${exportPrefix}class ${sym.name}${ext}`;
      lines.push(`${pad}${signature}`);

      for (const m of sym.methods || []) {
        const mPad = showLineNumbers ? String(m.line).padStart(5, " ") + ": " : "    ";
        const staticPrefix = m.static ? "static " : "";
        const asyncPrefix = m.async ? "async " : "";
        const accPrefix = m.accessor ? `${m.accessor} ` : "";
        let params = m.params ? "..." : "";
        if (params && params.length > maxParamLength) {
          params = params.slice(0, maxParamLength - 3) + "...";
        }
        lines.push(`${mPad}${staticPrefix}${asyncPrefix}${accPrefix}${m.name}(${params})`);
      }
      continue;
    }

    if (sym.kind === "function") {
      const asyncPrefix = sym.async ? "async " : "";
      let params = sym.params ? "..." : "";
      if (params && params.length > maxParamLength) {
        params = params.slice(0, maxParamLength - 3) + "...";
      }
      signature = `${exportPrefix}${asyncPrefix}function ${sym.name}(${params})`;
    } else if (sym.kind === "interface" || sym.kind === "type" || sym.kind === "enum") {
      signature = `${exportPrefix}${sym.kind} ${sym.name}`;
    } else if (sym.kind === "constant") {
      signature = `${exportPrefix}const ${sym.name}`;
    } else {
      signature = `${exportPrefix}${sym.kind} ${sym.name}`;
    }

    lines.push(`${pad}${signature}`);
  }

  return lines.join("\n");
}

/**
 * Bounded lexical index, not a semantic parser. Filesystem access is asynchronous and policy checked.
 * @typedef {{maxFiles?: number, maxLines?: number, maxEntries?: number, maxDepth?: number,
 * maxFileBytes?: number, maxTotalBytes?: number, maxOutputBytes?: number, ignoredDirs?: Set<string>,
 * displayPath?: (path: string) => string, assertPath?: (path: string) => void | Promise<void>,
 * throwIfCancelled?: () => void}} OutlineOptions
 */

/** @param {string} input @param {OutlineOptions} [options] */
export async function extractWorkspaceOutline(input, options = {}) {
  const maxFiles = outlineLimit(options.maxFiles, 30, 100);
  const budget = outlineTextBudget(options);
  const maxEntries = outlineLimit(options.maxEntries, 2048, 10000);
  const maxDepth = outlineLimit(options.maxDepth, 8, 32);
  const maxFileBytes = outlineLimit(options.maxFileBytes, 256 * 1024, 1024 * 1024);
  const maxTotalBytes = outlineLimit(options.maxTotalBytes, 2 * 1024 * 1024, 4 * 1024 * 1024);
  const check = options.throwIfCancelled || (() => {});
  const assertPath = options.assertPath || (() => {});
  const ignored = options.ignoredDirs || DEFAULT_IGNORED_DIRS;
  check();
  const root = await realpath(input);
  await assertPath(root);
  const rootInfo = await lstat(input);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("symbol outline requires a regular directory");
  const queue = [{ path: root, depth: 0 }];
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const warnings = [];
  let visitedEntries = 0;
  let truncated = false;
  scan: while (queue.length) {
    check();
    const directory = queue.shift();
    if (!directory) break;
    const canonical = await realpath(directory.path);
    if (canonical !== directory.path || !isContainedPath(root, canonical)) { warnings.push("changed_directory"); truncated = true; continue; }
    await assertPath(canonical);
    const entries = [];
    const handle = await opendir(canonical);
    for await (const entry of handle) {
      check();
      if (visitedEntries >= maxEntries) { truncated = true; break; }
      visitedEntries++;
      entries.push(entry);
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      check();
      const path = join(canonical, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith(".")) {
        if (directory.depth >= maxDepth) { truncated = true; continue; }
        queue.push({ path, depth: directory.depth + 1 });
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
        if (files.length >= maxFiles) { truncated = true; break scan; }
        files.push(path);
      }
    }
    if (visitedEntries >= maxEntries && (truncated || queue.length)) { truncated = true; break; }
  }
  let bytesRead = 0;
  let filesScanned = 0;
  let totalSymbols = 0;
  for (const path of files) {
    check();
    if (budget.full || bytesRead >= maxTotalBytes) { truncated = true; break; }
    try {
      await assertPath(path);
      const canonical = await realpath(path);
      if (!isContainedPath(root, canonical)) throw new Error("outline path changed");
      const file = await readRegularUtf8(path, Math.min(maxFileBytes, maxTotalBytes - bytesRead), "symbol source", { canonicalPath: canonical });
      check();
      bytesRead += file.bytes;
      filesScanned++;
      const symbols = extractFileSymbols(file.text, options.displayPath ? options.displayPath(path) : relative(root, path));
      totalSymbols += symbols.symbols.length;
      if (!symbols.symbols.length) continue;
      const block = [...(budget.hasContent ? [""] : []), ...renderSymbolOutline(symbols).split("\n")];
      if (!budget.append(block)) { truncated = true; break; }
    } catch {
      check();
      truncated = true;
      if (!warnings.includes("source_unavailable")) warnings.push("source_unavailable");
    }
  }
  const output = budget.finish(truncated, "... [Symbol outline truncated: budget reached or source unavailable]");
  return { ...output, filesScanned, totalSymbols, visitedEntries, bytesRead, warnings };
}

/** @param {string} input @param {OutlineOptions} [options] */
export async function extractSymbolOutline(input, options = {}) {
  const check = options.throwIfCancelled || (() => {});
  check();
  const info = await lstat(input);
  if (info.isSymbolicLink()) throw new Error("symbol outline must not follow a symbolic link");
  if (info.isDirectory()) return (await extractWorkspaceOutline(input, options)).outline;
  if (!info.isFile()) throw new Error("symbol outline requires a regular file");
  await options.assertPath?.(input);
  const canonical = await realpath(input);
  const file = await readRegularUtf8(input, outlineLimit(options.maxFileBytes, 256 * 1024, 1024 * 1024), "symbol source", { canonicalPath: canonical });
  check();
  const symbols = extractFileSymbols(file.text, options.displayPath ? options.displayPath(input) : relative(process.cwd(), input));
  const budget = outlineTextBudget(options);
  budget.append(renderSymbolOutline(symbols).split("\n"));
  return budget.finish(false, "... [Symbol outline truncated: budget reached]").outline;
}

/** @param {number | undefined} value @param {number} fallback @param {number} maximum */
function outlineLimit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Math.min(Number(value), maximum) : fallback;
}

/** @param {OutlineOptions} options */
function outlineTextBudget(options) {
  const maxLines = outlineLimit(options.maxLines, 300, 1000);
  const maxBytes = outlineLimit(options.maxOutputBytes, 16 * 1024, 64 * 1024);
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<string>} */
  const reasons = new Set();
  let bytes = 0;
  return {
    get full() { return lines.length >= maxLines || bytes >= maxBytes; },
    get hasContent() { return lines.length > 0; },
    /** @param {string[]} block */
    append(block) {
      for (const line of block) {
        if (lines.length >= maxLines) { reasons.add("line_limit"); return false; }
        const size = Buffer.byteLength(line) + (lines.length ? 1 : 0);
        if (bytes + size > maxBytes) { reasons.add("output_byte_limit"); return false; }
        lines.push(line); bytes += size;
      }
      return true;
    },
    finish(incomplete = false, notice = "... [Symbol outline truncated]") {
      const truncated = incomplete || reasons.size > 0;
      if (truncated) {
        if (lines.length >= maxLines) reasons.add("line_limit");
        if (bytes >= maxBytes) reasons.add("output_byte_limit");
        if (!reasons.size) reasons.add("source_incomplete");
        if (Buffer.byteLength(notice) > maxBytes) notice = ".".repeat(Math.min(3, maxBytes));
        const noticeBytes = Buffer.byteLength(notice);
        while (lines.length && (lines.at(-1) === "" || lines.length >= maxLines || bytes + 1 + noticeBytes > maxBytes)) {
          const removed = /** @type {string} */ (lines.pop());
          bytes -= Buffer.byteLength(removed) + (lines.length ? 1 : 0);
        }
        bytes += (lines.length ? 1 : 0) + noticeBytes;
        lines.push(notice);
      }
      return { outline: lines.join("\n"), truncated, outputBytes: bytes, truncationReasons: [...reasons] };
    },
  };
}
