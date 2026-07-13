import { commandMatchText, recommendTools, relevanceScore, tokenize } from "../src/local/capability-ranking.mjs";

assert(relevanceScore("create a skill", "Skill creator workflow", "skill-creator") > relevanceScore("create a skill", "frontend design", "frontend-design"), "identity weighting does not prefer the named capability");
assert(relevanceScore("创建技能", "create skill creator", "skill-creator") > 0, "Chinese intent aliases do not match English metadata");
assert(relevanceScore("verify documentation", "documentation validation", "docs-verify") > 0, "English canonicalization is broken");
assert(relevanceScore("unrelated", "browser automation", "browser") === 0, "unrelated capabilities received a false score");
const tokens = tokenize("安装最新浏览器工具");
assert(tokens.has("install") && tokens.has("browser") && tokens.has("latest"), "bilingual token expansion is incomplete");
const command = commandMatchText({ name: "package.test", description: "Run tests", argv: ["npm", "test"], searchTerms: "测试" });
assert(command.includes("package.test") && command.includes("测试"), "command search text lost metadata");
const tools = recommendTools("在浏览器填写表单并检查 git diff", { commandsAvailable: true, commandRelevant: false, skillRelevant: false });
assert(tools.includes("browser_fill_form") && tools.includes("git_diff"), "tool recommendation lost browser or Git intent");
assert(new Set(tools).size === tools.length, "tool recommendation returned duplicates");
console.log("capability ranking test ok");

function assert(condition, message) { if (!condition) throw new Error(message); }
