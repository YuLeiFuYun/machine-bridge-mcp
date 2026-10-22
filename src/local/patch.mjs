import { BridgeError } from "./errors.mjs";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const SECTION_PREFIXES = ["*** Add File: ", "*** Update File: ", "*** Delete File: "];

export function parsePatchEnvelope(input) {
  const text = String(input ?? "").replaceAll("\r\n", "\n");
  const lines = text.split("\n");
  if (lines[0] !== BEGIN) throw new BridgeError("invalid_request", `patch must start with ${BEGIN}`, { details: { reason: "missing_begin_marker" } });
  const endIndex = lines.lastIndexOf(END);
  if (endIndex < 1) throw new BridgeError("invalid_request", `patch must end with ${END}`, { details: { reason: "missing_end_marker" } });
  if (lines.slice(endIndex + 1).some((line) => line !== "")) throw new BridgeError("invalid_request", "unexpected content after patch envelope", { details: { reason: "trailing_content" } });

  const operations = [];
  let index = 1;
  while (index < endIndex) {
    if (!lines[index]) {
      index += 1;
      continue;
    }
    const header = lines[index];
    const kind = header.startsWith(SECTION_PREFIXES[0])
      ? "add"
      : header.startsWith(SECTION_PREFIXES[1])
        ? "update"
        : header.startsWith(SECTION_PREFIXES[2])
          ? "delete"
          : "";
    if (!kind) throw new BridgeError("invalid_request", `invalid patch section header at line ${index + 1}`, { details: { reason: "invalid_section_header", line: index + 1 } });
    const prefix = SECTION_PREFIXES[kind === "add" ? 0 : kind === "update" ? 1 : 2];
    const path = header.slice(prefix.length).trim();
    if (!path) throw new BridgeError("invalid_request", `patch ${kind} path is empty`, { details: { reason: "empty_path", operation: kind } });
    index += 1;

    if (kind === "add") {
      const contentLines = [];
      while (index < endIndex && !isSectionHeader(lines[index])) {
        const line = lines[index];
        if (!line.startsWith("+")) throw new BridgeError("invalid_request", `added file content must start with + at line ${index + 1}`, { details: { reason: "invalid_add_line", line: index + 1 } });
        contentLines.push(line.slice(1));
        index += 1;
      }
      operations.push({ kind, path, content: contentLines.length ? `${contentLines.join("\n")}\n` : "" });
      continue;
    }

    if (kind === "delete") {
      if (index < endIndex && !isSectionHeader(lines[index]) && lines[index] !== "") {
        throw new BridgeError("invalid_request", `delete section must not contain patch body at line ${index + 1}`, { details: { reason: "unexpected_delete_body", line: index + 1 } });
      }
      operations.push({ kind, path });
      continue;
    }

    let moveTo = "";
    if (lines[index]?.startsWith("*** Move to: ")) {
      moveTo = lines[index].slice("*** Move to: ".length).trim();
      if (!moveTo) throw new BridgeError("invalid_request", "move destination is empty", { details: { reason: "empty_move_destination" } });
      index += 1;
    }
    const hunks = [];
    while (index < endIndex && !isSectionHeader(lines[index])) {
      if (!lines[index]) {
        index += 1;
        continue;
      }
      if (!lines[index].startsWith("@@")) throw new BridgeError("invalid_request", `update hunk must start with @@ at line ${index + 1}`, { details: { reason: "missing_hunk_header", line: index + 1 } });
      const headerText = lines[index].slice(2).trim();
      index += 1;
      const hunkLines = [];
      while (index < endIndex && !isSectionHeader(lines[index]) && !lines[index].startsWith("@@")) {
        const line = lines[index];
        if (!line || ![" ", "+", "-"].includes(line[0])) {
          throw new BridgeError("invalid_request", `invalid update line prefix at line ${index + 1}`, { details: { reason: "invalid_update_line", line: index + 1 } });
        }
        hunkLines.push({ type: line[0], text: line.slice(1) });
        index += 1;
      }
      if (!hunkLines.length) throw new BridgeError("invalid_request", "empty update hunk", { details: { reason: "empty_hunk" } });
      if (!hunkLines.some((line) => line.type !== "+")) throw new BridgeError("invalid_request", "update hunk needs context or removed lines", { details: { reason: "context_free_hunk" } });
      hunks.push({ header: headerText, lines: hunkLines });
    }
    if (!hunks.length) throw new BridgeError("invalid_request", "update section contains no hunks", { details: { reason: "missing_hunks" } });
    operations.push({ kind, path, moveTo: moveTo || undefined, hunks });
  }

  if (!operations.length) throw new BridgeError("invalid_request", "patch contains no file operations", { details: { reason: "empty_patch" } });
  const touched = new Set();
  for (const operation of operations) {
    for (const path of [operation.path, operation.moveTo].filter(Boolean)) {
      if (touched.has(path)) throw new BridgeError("conflict", "patch touches the same path more than once", { details: { reason: "duplicate_path" } });
      touched.add(path);
    }
  }
  return operations;
}

/**
 * Apply update hunks without rewriting the file's line endings.
 *
 * Hunk text is always LF in the patch envelope, so matching happens on LF-normalized line
 * text, but every untouched line keeps its exact original terminator. Replacement lines
 * inherit the terminators of the lines they replace; inserted lines inherit the local
 * terminator. Mixed CRLF/LF files therefore retain their per-line style instead of falling
 * back to LF, and a missing final newline remains missing.
 */
export function applyUpdateHunks(content, hunks) {
  const { lines, terminators } = splitLinesWithTerminators(String(content));
  const defaultEol = preferredLineEnding(terminators);
  let searchFrom = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldLines = hunk.lines.filter((line) => line.type !== "+").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.type !== "-").map((line) => line.text);
    const matches = findSequenceMatches(lines, oldLines, searchFrom);
    if (matches.length === 0) {
      throw new BridgeError("conflict", "patch context did not match current file state", {
        details: { reason: "context_not_found", hunk: hunkIndex + 1, conflict_hint: buildConflictHint(lines, oldLines, matches) },
      });
    }
    if (matches.length > 1) {
      throw new BridgeError("conflict", "patch context matched more than once", {
        details: { reason: "context_ambiguous", hunk: hunkIndex + 1, conflict_hint: buildConflictHint(lines, oldLines, matches) },
      });
    }
    const at = matches[0];
    const removedTerminators = terminators.slice(at, at + oldLines.length);
    const replacementTerminators = replacementLineTerminators({
      removedTerminators, newLineCount: newLines.length, terminators, at, defaultEol,
    });
    lines.splice(at, oldLines.length, ...newLines);
    terminators.splice(at, oldLines.length, ...replacementTerminators);
    searchFrom = at + newLines.length;
  }

  return lines.map((line, index) => `${line}${terminators[index]}`).join("");
}

function buildConflictHint(lines, oldLines, matches) {
  const probe = oldLines.find((line) => line.trim().length > 0) ?? oldLines[0] ?? "";
  const trimmedProbe = probe.trim();
  const candidateLines = matches.length > 1
    ? matches.slice(0, 3).map((index) => index + 1)
    : trimmedProbe
      ? lines.reduce((acc, line, index) => {
        if (acc.length < 3 && (line === probe || line.trim() === trimmedProbe)) acc.push(index + 1);
        return acc;
      }, [])
      : [];
  return {
    first_expected_line: probe.slice(0, 120),
    candidate_lines: candidateLines,
  };
}

function splitLinesWithTerminators(source) {
  if (!source) return { lines: [""], terminators: [""] };
  const lines = [];
  const terminators = [];
  let lineStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") continue;
    const crlf = index > lineStart && source[index - 1] === "\r";
    lines.push(source.slice(lineStart, crlf ? index - 1 : index));
    terminators.push(crlf ? "\r\n" : "\n");
    lineStart = index + 1;
  }
  if (lineStart < source.length) {
    lines.push(source.slice(lineStart));
    terminators.push("");
  }
  return { lines, terminators };
}

function preferredLineEnding(terminators) {
  const crlf = terminators.filter((value) => value === "\r\n").length;
  const lf = terminators.filter((value) => value === "\n").length;
  return crlf > lf ? "\r\n" : "\n";
}

function replacementLineTerminators({ removedTerminators, newLineCount, terminators, at, defaultEol }) {
  if (!newLineCount) return [];
  if (!removedTerminators.length) {
    const before = at > 0 ? terminators[at - 1] : "";
    const after = at < terminators.length ? terminators[at] : "";
    const fill = before || after || defaultEol;
    if (at > 0 && before === "") terminators[at - 1] = defaultEol;
    return Array.from({ length: newLineCount }, (_, index) => (
      at === terminators.length && index === newLineCount - 1 && before === "" ? "" : fill
    ));
  }

  const replacement = removedTerminators.slice(0, newLineCount);
  const fill = removedTerminators.at(-1) || defaultEol;
  while (replacement.length < newLineCount) replacement.push(fill);

  if (removedTerminators.at(-1) === "") {
    // The replaced region ended at EOF without a newline. Only the new final line may keep
    // that state; any lines before it need a real separator.
    replacement[newLineCount - 1] = "";
    for (let index = 0; index < newLineCount - 1; index += 1) {
      if (!replacement[index]) replacement[index] = defaultEol;
    }
  }
  return replacement;
}

function findSequenceMatches(lines, sequence, start) {
  const matches = [];
  if (!sequence.length) return matches;
  for (let index = Math.max(0, start); index <= lines.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (lines[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  return matches;
}

function isSectionHeader(line) {
  return SECTION_PREFIXES.some((prefix) => line.startsWith(prefix));
}
