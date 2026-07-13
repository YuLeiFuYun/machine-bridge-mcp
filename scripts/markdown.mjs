export function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}
