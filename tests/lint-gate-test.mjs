import { ESLint } from "eslint";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: root });

const nodeResults = await eslint.lintText(
  "export function startupProbe() { return missingStartupBinding; }\n",
  { filePath: join(root, "src", "local", "__lint-startup-probe__.mjs") },
);
assertNoUndef(nodeResults[0], "missingStartupBinding", "Node production configuration");

const sharedResults = await eslint.lintText(
  "export function sharedProbe() { return missingSharedBinding; }\n",
  { filePath: join(root, "src", "shared", "__lint-shared-probe__.mjs") },
);
assertNoUndef(sharedResults[0], "missingSharedBinding", "shared runtime configuration");

const browserResults = await eslint.lintText(
  "importScripts('fixture.js');\nfunction browserProbe() { return missingBrowserBinding; }\nvoid browserProbe;\n",
  { filePath: join(root, "browser-extension", "__lint-browser-probe__.js") },
);
assertNoUndef(browserResults[0], "missingBrowserBinding", "browser-extension configuration");
if (browserResults[0].messages.some((message) => message.ruleId === "no-undef" && message.message.includes("importScripts"))) {
  throw new Error("browser-extension lint configuration rejected the valid importScripts service-worker global");
}

const correctnessResults = await eslint.lintText(
  [
    "new Promise((resolve) => setTimeout(resolve, 1));",
    "function unsafeFinally() { try { return 1; } finally { throw new Error('lost'); } }",
    "void unsafeFinally;",
  ].join("\n"),
  { filePath: join(root, "src", "local", "__lint-correctness-probe__.mjs") },
);
for (const ruleId of ["no-promise-executor-return", "no-unsafe-finally"]) {
  if (!correctnessResults[0].messages.some((message) => message.ruleId === ruleId)) {
    throw new Error(`correctness lint configuration did not enforce ${ruleId}: ${JSON.stringify(correctnessResults[0].messages)}`);
  }
}

const unusedResults = await eslint.lintText(
  'import { readFile } from "node:fs/promises";\nvoid 0;',
  { filePath: join(root, "src", "shared", "__lint-unused-probe__.mjs") },
);
if (!unusedResults[0].messages.some((message) => message.ruleId === "no-unused-vars" && message.message.includes("readFile"))) {
  throw new Error(`semantic lint configuration did not reject an unused import: ${JSON.stringify(unusedResults[0].messages)}`);
}

// Scope guard: a lint command that silently ignores part of the tree is worse than no lint
// command, because it reports success. Every source file must therefore be covered by
// eslint.config.mjs or be listed below with the reason it cannot be.
const UNLINTED_SOURCE_EXCEPTIONS = Object.freeze([
  {
    prefix: "src/",
    suffix: ".d.ts",
    reason: "ambient declaration file with no runtime code to lint",
  },
  {
    prefix: "src/worker/",
    suffix: ".ts",
    reason: "eslint 10 has no TypeScript parser that accepts typescript 7; src/worker is covered by `tsc -p tsconfig.json` with strict, noUnusedLocals and noUnusedParameters",
  },
]);
const lintTargets = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.lint || "")
  .trim().split(/\s+/).slice(1);
const isExcepted = (file) => UNLINTED_SOURCE_EXCEPTIONS.some((entry) => file.startsWith(entry.prefix) && file.endsWith(entry.suffix));
const sourceRoots = ["bin", "src", "scripts", "tests", "browser-extension", ".github/scripts"];
const unlinted = [];
for (const file of sourceFiles(sourceRoots)) {
  const config = await eslint.calculateConfigForFile(file);
  const hasRules = config !== undefined && Object.values(config.rules || {}).some((severity) => severity !== "off" && severity !== 0);
  if (!hasRules && !isExcepted(file)) unlinted.push(file);
}
if (unlinted.length) {
  throw new Error(`source files are outside every eslint config block: ${unlinted.slice(0, 10).join(", ")}${unlinted.length > 10 ? ` (+${unlinted.length - 10})` : ""}`);
}
for (const exception of UNLINTED_SOURCE_EXCEPTIONS) {
  if (!sourceFiles(["src"]).some(isExcepted)) {
    throw new Error(`stale lint exception for ${exception.prefix}**${exception.suffix}; remove it so the tree stays honestly covered`);
  }
}
for (const directory of readdirSync(join(root, "src"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `src/${entry.name}`)) {
  const files = sourceFiles(["src"]).filter((file) => file.startsWith(`${directory}/`));
  if (!files.length || files.every(isExcepted)) continue;
  if (!lintTargets.includes(directory)) {
    throw new Error(`the lint command does not traverse ${directory}; eslint.config.mjs may cover it, but nothing would ever check`);
  }
}

console.log("semantic JavaScript lint gate test ok");

function assertNoUndef(result, name, label) {
  const findings = result.messages.filter((message) => message.ruleId === "no-undef");
  if (!findings.some((message) => message.message.includes(name))) {
    throw new Error(`${label} did not reject the undefined identifier ${name}: ${JSON.stringify(result.messages)}`);
  }
}

function sourceFiles(roots) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relativePath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
        walk(relativePath);
      } else if (/\.(?:mjs|js|ts)$/.test(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  for (const directory of roots) walk(directory);
  return files;
}
