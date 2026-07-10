const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const SECTION_PREFIXES = ["*** Add File: ", "*** Update File: ", "*** Delete File: "];

export function parsePatchEnvelope(input) {
  const text = String(input ?? "").replaceAll("\r\n", "\n");
  const lines = text.split("\n");
  if (lines[0] !== BEGIN) throw new Error(`patch must start with ${BEGIN}`);
  const endIndex = lines.lastIndexOf(END);
  if (endIndex < 1) throw new Error(`patch must end with ${END}`);
  if (lines.slice(endIndex + 1).some((line) => line !== "")) throw new Error("unexpected content after patch envelope");

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
    if (!kind) throw new Error(`invalid patch section header at line ${index + 1}`);
    const prefix = SECTION_PREFIXES[kind === "add" ? 0 : kind === "update" ? 1 : 2];
    const path = header.slice(prefix.length).trim();
    if (!path) throw new Error(`patch ${kind} path is empty`);
    index += 1;

    if (kind === "add") {
      const contentLines = [];
      while (index < endIndex && !isSectionHeader(lines[index])) {
        const line = lines[index];
        if (!line.startsWith("+")) throw new Error(`added file content must start with + at line ${index + 1}`);
        contentLines.push(line.slice(1));
        index += 1;
      }
      operations.push({ kind, path, content: contentLines.length ? `${contentLines.join("\n")}\n` : "" });
      continue;
    }

    if (kind === "delete") {
      if (index < endIndex && !isSectionHeader(lines[index]) && lines[index] !== "") {
        throw new Error(`delete section must not contain patch body at line ${index + 1}`);
      }
      operations.push({ kind, path });
      continue;
    }

    let moveTo = "";
    if (lines[index]?.startsWith("*** Move to: ")) {
      moveTo = lines[index].slice("*** Move to: ".length).trim();
      if (!moveTo) throw new Error("move destination is empty");
      index += 1;
    }
    const hunks = [];
    while (index < endIndex && !isSectionHeader(lines[index])) {
      if (!lines[index]) {
        index += 1;
        continue;
      }
      if (!lines[index].startsWith("@@")) throw new Error(`update hunk must start with @@ at line ${index + 1}`);
      const headerText = lines[index].slice(2).trim();
      index += 1;
      const hunkLines = [];
      while (index < endIndex && !isSectionHeader(lines[index]) && !lines[index].startsWith("@@")) {
        const line = lines[index];
        if (!line || ![" ", "+", "-"].includes(line[0])) {
          throw new Error(`invalid update line prefix at line ${index + 1}`);
        }
        hunkLines.push({ type: line[0], text: line.slice(1) });
        index += 1;
      }
      if (!hunkLines.length) throw new Error("empty update hunk");
      if (!hunkLines.some((line) => line.type !== "+")) throw new Error("update hunk needs context or removed lines");
      hunks.push({ header: headerText, lines: hunkLines });
    }
    if (!hunks.length) throw new Error(`update section for ${path} contains no hunks`);
    operations.push({ kind, path, moveTo: moveTo || undefined, hunks });
  }

  if (!operations.length) throw new Error("patch contains no file operations");
  const touched = new Set();
  for (const operation of operations) {
    for (const path of [operation.path, operation.moveTo].filter(Boolean)) {
      if (touched.has(path)) throw new Error(`patch touches the same path more than once: ${path}`);
      touched.add(path);
    }
  }
  return operations;
}

export function applyUpdateHunks(content, hunks, path = "file") {
  const normalized = String(content).replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  let lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  let searchFrom = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldLines = hunk.lines.filter((line) => line.type !== "+").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.type !== "-").map((line) => line.text);
    const matches = findSequenceMatches(lines, oldLines, searchFrom);
    if (matches.length === 0) {
      throw new Error(`patch context not found for ${path} hunk ${hunkIndex + 1}`);
    }
    if (matches.length > 1) {
      throw new Error(`patch context is ambiguous for ${path} hunk ${hunkIndex + 1}`);
    }
    const at = matches[0];
    lines.splice(at, oldLines.length, ...newLines);
    searchFrom = at + newLines.length;
  }

  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
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
