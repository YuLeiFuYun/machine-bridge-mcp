export function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

export function normalizeLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n");
}
