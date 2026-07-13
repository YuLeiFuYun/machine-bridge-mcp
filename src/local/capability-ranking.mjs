const TOKEN_STOP_WORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "use", "using", "into", "of", "to", "a", "an", "in", "on", "is", "are", "or", "及", "和", "的", "了", "在", "用", "使用", "进行", "根据"]);
const ENGLISH_TOKEN_CANONICAL = new Map([
  ["created", "create"], ["creating", "create"], ["creation", "create"], ["creator", "create"],
  ["improved", "improve"], ["improving", "improve"], ["improvement", "improve"],
  ["installed", "install"], ["installing", "install"], ["installation", "install"], ["installer", "install"],
  ["searched", "search"], ["searching", "search"], ["finder", "find"],
  ["documentation", "docs"], ["document", "docs"], ["documents", "docs"],
  ["validated", "verify"], ["validate", "verify"], ["validation", "verify"], ["verification", "verify"],
  ["factcheck", "verify"], ["fact-check", "verify"], ["testing", "test"], ["tests", "test"],
  ["building", "build"], ["built", "build"], ["deployment", "deploy"], ["deployed", "deploy"],
]);
const HAN_TOKEN_ALIASES = Object.freeze([
  [/创建|新建|编写/u, ["create", "creator"]],
  [/改进|优化|更新|维护/u, ["improve", "update"]],
  [/技能/u, ["skill"]],
  [/安装/u, ["install", "installer"]],
  [/部署/u, ["deploy", "deployment"]],
  [/查找|搜索|检索/u, ["search", "find"]],
  [/最新|当前/u, ["latest", "current"]],
  [/官方/u, ["official"]],
  [/文档|资料/u, ["docs", "documentation"]],
  [/事实核查|核查|验证|校验/u, ["verify", "factcheck"]],
  [/测试/u, ["test"]],
  [/前端/u, ["frontend"]],
  [/设计/u, ["design"]],
  [/邮件|邮箱/u, ["email"]],
  [/浏览器|网页|网站/u, ["browser", "web"]],
  [/性能/u, ["performance"]],
  [/安全|漏洞/u, ["security", "audit"]],
]);

export function commandMatchText(command) {
  return `${command.name} ${command.description} ${command.argv.join(" ")} ${command.searchTerms || ""}`;
}

export function relevanceScore(task, candidate, identity = "") {
  const taskTokens = tokenize(task);
  const candidateTokens = tokenize(candidate);
  if (!taskTokens.size || !candidateTokens.size) return 0;
  const identityTokens = tokenize(identity);
  let score = 0;
  for (const token of taskTokens) {
    if (candidateTokens.has(token)) score += token.length >= 6 ? 2 : 1;
    if (identityTokens.has(token)) score += token.length >= 6 ? 4 : 3;
  }
  const taskComparable = comparableText(task);
  const candidateComparable = comparableText(candidate);
  const identityComparable = comparableText(identity);
  if (candidateComparable.includes(taskComparable) || taskComparable.includes(candidateComparable)) score += 4;
  if (identityComparable.length >= 3 && ` ${taskComparable} `.includes(` ${identityComparable} `)) score += 12;
  return score;
}

export function recommendTools(task, { commandsAvailable, commandRelevant, skillRelevant }) {
  const lower = String(task || "").toLowerCase();
  const tools = ["agent_context"];
  if (skillRelevant) tools.push("load_local_skill");
  if (commandRelevant) tools.push("run_local_command");
  if (/browser|chrome|edge|brave|网页|浏览器|表单|网站/.test(lower)) tools.push("browser_status", "browser_list_tabs", "browser_manage_tabs", "browser_inspect_page", "browser_wait", "browser_action", "browser_fill_form");
  if (/app|application|gui|window|应用|软件|窗口|界面/.test(lower)) tools.push("list_local_applications", "inspect_local_application", "operate_local_application");
  if (/git|commit|branch|diff|仓库|提交|分支/.test(lower)) tools.push("git_status", "git_diff");
  if (/test|build|lint|command|terminal|测试|构建|命令|终端/.test(lower)) tools.push(commandsAvailable ? "run_local_command" : "run_process");
  if (/file|code|source|edit|write|文件|代码|源码|修改|写入/.test(lower)) tools.push("read_file", "search_text", "edit_file", "apply_patch");
  return [...new Set(tools)];
}

export function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set();
  for (const raw of text.match(/[a-z0-9_][a-z0-9_.-]{1,}/g) || []) {
    const token = raw.replace(/^[.-]+|[.-]+$/g, "");
    addToken(tokens, token);
    for (const part of token.split(/[._-]+/)) addToken(tokens, part);
  }
  for (const sequence of text.match(/[\p{Script=Han}]{1,}/gu) || []) {
    addToken(tokens, sequence);
    const minimumSize = sequence.length === 1 ? 1 : 2;
    for (let size = minimumSize; size <= Math.min(3, sequence.length); size += 1) {
      for (let index = 0; index + size <= sequence.length; index += 1) addToken(tokens, sequence.slice(index, index + size));
    }
  }
  for (const [pattern, aliases] of HAN_TOKEN_ALIASES) {
    if (!pattern.test(text)) continue;
    for (const alias of aliases) addToken(tokens, alias);
  }
  return tokens;
}

function comparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function addToken(tokens, raw) {
  const token = String(raw || "").replace(/^[.-]+|[.-]+$/g, "");
  if (token.length < 2 || TOKEN_STOP_WORDS.has(token)) return;
  tokens.add(token);
  const canonical = ENGLISH_TOKEN_CANONICAL.get(token);
  if (canonical) tokens.add(canonical);
}
