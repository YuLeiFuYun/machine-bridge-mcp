import { ESLint } from "eslint";
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

console.log("semantic JavaScript lint gate test ok");

function assertNoUndef(result, name, label) {
  const findings = result.messages.filter((message) => message.ruleId === "no-undef");
  if (!findings.some((message) => message.message.includes(name))) {
    throw new Error(`${label} did not reject the undefined identifier ${name}: ${JSON.stringify(result.messages)}`);
  }
}
