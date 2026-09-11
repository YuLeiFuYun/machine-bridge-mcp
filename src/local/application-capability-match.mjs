export function applicationMatchScore(task, application) {
  const text = String(task || "").toLowerCase();
  const name = String(application?.name || "").toLowerCase();
  const id = String(application?.id || "").toLowerCase();
  if (!name) return 0;
  if (text.includes(name)) return 10 + Math.min(name.length, 20);
  if (!applicationOperationIntent(text)) return 0;
  const taskTokens = new Set(text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2));
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  return words.reduce((score, word) => score + (taskTokens.has(word) ? 2 : 0), id && text.includes(id) ? 5 : 0);
}

export function applicationOperationIntent(task) {
  return /\b(?:open|launch|click|focus|activate|application|app|window|menu)\b|打开|启动|检查应用|操作应用|应用|软件|窗口|菜单/i.test(String(task || ""));
}
