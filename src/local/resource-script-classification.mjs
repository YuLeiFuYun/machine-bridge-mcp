import { basename } from "node:path";
const HEAVY_SCRIPT_MARKER = /(?:^|[._-])(?:check|checks|build|test|tests|testing|verify|verification|gate|release|archive|fuzz|coverage|benchmark|bench|smoke)(?:$|[._-])/i;
const HEAVY_PACKAGE_SEGMENT = /(?:^|[:._-])(?:check|build|test|tests|verify|gate|release|archive|fuzz|coverage|benchmark|bench|smoke)(?:$|[:._-])/i;
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|js|mjs|cjs|py|rb|pl)$/i;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
export function heavyScriptName(value) {
  const raw = String(value || "");
  const name = basename(raw).toLowerCase();
  const scriptLike = raw.includes("/") || raw.includes("\\") || SCRIPT_EXTENSION.test(name);
  return scriptLike && HEAVY_SCRIPT_MARKER.test(name);
}

export function directInterpreterHeavyScript(base, args = []) {
  const node = base === "node" || base === "node.exe";
  const python = /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(base);
  if (!node && !python) return false;
  const values = args.map(String);
  if (python && values.some((value) => ["-c", "-m"].includes(value))) return false;
  if (node && values.some((value) => ["-e", "--eval", "-p", "--print"].includes(value))) return false;
  const operand = values.find((value) => !value.startsWith("-")) || "";
  return Boolean(operand && heavyScriptName(operand));
}
export function verificationPlanCommand(base, args = []) {
  const values = args.map(String);
  if ((base === "node" || base === "node.exe") && basename(values.find((value) => !value.startsWith("-")) || "").toLowerCase() === "run-checks.mjs") return true;
  if (!PACKAGE_MANAGERS.has(base)) return false;
  const first = String(values[0] || "").toLowerCase();
  const script = ["run", "run-script"].includes(first) ? String(values[1] || "").toLowerCase() : first;
  return ["check", "check:fast", "check:full", "check:platform"].includes(script);
}

export function packageManagerTokensHeavy(tokens = []) {
  const head = String(tokens[0] || "").toLowerCase();
  if (!PACKAGE_MANAGERS.has(head)) return false;
  const args = tokens.slice(1).map((value) => String(value));
  const first = String(args[0] || "").toLowerCase();
  if (["install", "ci", "build", "test"].includes(first)) return true;
  if (["run", "run-script"].includes(first)) return heavyPackageScriptName(args[1]);
  return ["pnpm", "yarn", "bun"].includes(head) && heavyPackageScriptName(first);
}

export function heavyPackageScriptName(value) {
  return HEAVY_PACKAGE_SEGMENT.test(String(value || "").toLowerCase());
}
