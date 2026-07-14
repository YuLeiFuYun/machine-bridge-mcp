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

const browserResults = await eslint.lintText(
  "importScripts('fixture.js');\nfunction browserProbe() { return missingBrowserBinding; }\nvoid browserProbe;\n",
  { filePath: join(root, "browser-extension", "__lint-browser-probe__.js") },
);
assertNoUndef(browserResults[0], "missingBrowserBinding", "browser-extension configuration");
if (browserResults[0].messages.some((message) => message.ruleId === "no-undef" && message.message.includes("importScripts"))) {
  throw new Error("browser-extension lint configuration rejected the valid importScripts service-worker global");
}

console.log("semantic JavaScript lint gate test ok");

function assertNoUndef(result, name, label) {
  const findings = result.messages.filter((message) => message.ruleId === "no-undef");
  if (!findings.some((message) => message.message.includes(name))) {
    throw new Error(`${label} did not reject the undefined identifier ${name}: ${JSON.stringify(result.messages)}`);
  }
}
