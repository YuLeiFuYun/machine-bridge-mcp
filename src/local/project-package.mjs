import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

const MAX_METADATA_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_COMMANDS = 64;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const PACKAGE_SCRIPT_INTENTS = Object.freeze({
  check: "check verify validate validation test lint typecheck 完整测试 检查 验证 测试 校验 审查",
  verify: "check verify validate validation test 检查 验证 测试 校验",
  validate: "check verify validate validation test 检查 验证 测试 校验",
  test: "test tests testing unit integration 完整测试 测试 单元测试 集成测试",
  lint: "lint static analysis code quality 检查 静态检查 代码质量",
  typecheck: "typecheck type check typescript 类型检查",
  build: "build compile bundle package 构建 编译 打包",
  compile: "build compile 构建 编译",
  format: "format formatting 格式化",
  start: "start run launch 启动 运行",
  dev: "develop development start server 开发 启动 服务",
  serve: "serve server start 服务 启动",
  audit: "audit security vulnerability 审计 安全 漏洞",
  deploy: "deploy deployment 部署",
  release: "release publish 发布",
  publish: "publish release 发布",
  pack: "pack package 打包",
  prepack: "pack package 打包",
});

const LOCKFILES = Object.freeze([
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
]);

export async function readProjectPackageMetadata(root, throwIfCancelled = () => {}) {
  const packagePath = join(root, "package.json");
  const packageText = await readOptionalRegularUtf8(packagePath, MAX_METADATA_FILE_BYTES);
  const lockfiles = [];
  for (const [name, manager] of LOCKFILES) {
    throwIfCancelled();
    if (await isRegularNonSymlink(join(root, name))) lockfiles.push({ name, manager });
  }
  if (!packageText) {
    return {
      detected: lockfiles.length > 0,
      packagePath,
      packageState: "missing",
      declaredManager: "",
      managerName: uniqueLockManager(lockfiles),
      lockfiles,
      scripts: [],
      engines: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    return invalidPackageMetadata(packagePath, lockfiles, "invalid-json");
  }
  if (!isPlainRecord(parsed)) return invalidPackageMetadata(packagePath, lockfiles, "invalid-root");

  const declaredManager = safePackageManager(parsed.packageManager);
  const scripts = isPlainRecord(parsed.scripts)
    ? Object.entries(parsed.scripts)
      .filter(([name, value]) => validScriptName(name) && typeof value === "string")
      .map(([name]) => name)
    : [];
  const engines = isPlainRecord(parsed.engines)
    ? Object.entries(parsed.engines)
      .map(([name, value]) => [name, safeVersionValue(value)])
      .filter(([name, value]) => /^[A-Za-z0-9_.-]{1,40}$/.test(name) && value)
      .slice(0, 10)
    : [];

  const inferredManager = packageManagerName(declaredManager) || uniqueLockManager(lockfiles);
  return {
    detected: true,
    packagePath,
    packageState: "valid",
    declaredManager,
    managerName: inferredManager || (lockfiles.length === 0 ? "npm" : ""),
    lockfiles,
    scripts: prioritizeScriptNames(scripts),
    engines,
  };
}

export function packageScriptCommand(manager, script, platform = process.platform, commandShell = process.env.ComSpec || "cmd.exe") {
  const executable = PACKAGE_MANAGERS.has(manager) ? manager : "npm";
  if (!validScriptName(script)) throw new Error("package script name is invalid");
  if (platform === "win32") return [commandShell, "/d", "/s", "/c", `${executable} run ${script}`];
  return [executable, "run", script];
}

export function packageScriptDisplayCommand(manager, script) {
  const executable = PACKAGE_MANAGERS.has(manager) ? manager : "npm";
  if (!validScriptName(script)) throw new Error("package script name is invalid");
  return `${executable} run ${script}`;
}

export function automaticPackageCommands(metadata, cwd, platform = process.platform) {
  if (metadata?.packageState !== "valid" || !metadata.managerName || !metadata.scripts?.length) return new Map();
  const commands = new Map();
  for (const script of metadata.scripts.slice(0, MAX_PACKAGE_COMMANDS)) {
    const base = normalizedCommandName(script);
    if (!base) continue;
    let name = `package.${base}`;
    let suffix = 2;
    while (commands.has(name)) name = `package.${base}.${suffix++}`;
    commands.set(name, {
      name,
      description: `Run the declared package script '${script}' using the detected package manager.`,
      argv: packageScriptCommand(metadata.managerName, script, platform),
      cwd,
      timeoutSeconds: 600,
      allowExtraArgs: false,
      source: metadata.packagePath,
      sourceType: "automatic-package-script",
      searchTerms: packageScriptSearchTerms(script),
      script,
    });
  }
  return commands;
}

export function safeVersionValue(value) {
  if (typeof value !== "string") return "";
  const normalized = safeSingleLine(value, 120);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9 ._*+<>=~^|&!/-]{0,119}$/.test(normalized) ? normalized : "";
}


function packageScriptSearchTerms(script) {
  const normalized = String(script).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const root = normalized.split("-")[0];
  return PACKAGE_SCRIPT_INTENTS[root] || "";
}

function invalidPackageMetadata(packagePath, lockfiles, packageState) {
  return {
    detected: true,
    packagePath,
    packageState,
    declaredManager: "",
    managerName: uniqueLockManager(lockfiles),
    lockfiles,
    scripts: [],
    engines: [],
  };
}

function packageManagerName(value) {
  if (!value) return "";
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(value.trim());
  return match?.[1] || "";
}

function uniqueLockManager(lockfiles) {
  const managers = [...new Set(lockfiles.map((item) => item.manager))];
  return managers.length === 1 ? managers[0] : "";
}

function prioritizeScriptNames(names) {
  const preferred = ["check", "test", "lint", "typecheck", "build", "format", "verify", "ci", "prepack", "start", "dev"];
  const rank = new Map(preferred.map((name, index) => [name, index]));
  return [...new Set(names)].sort((left, right) => {
    const leftRank = rank.has(left) ? rank.get(left) : preferred.length;
    const rightRank = rank.has(right) ? rank.get(right) : preferred.length;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

function validScriptName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,119}$/.test(value);
}

function normalizedCommandName(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return /^[a-z][a-z0-9._-]{0,47}$/.test(normalized) ? normalized : "";
}

function safePackageManager(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^(?:npm|pnpm|yarn|bun)@[A-Za-z0-9][A-Za-z0-9.+_-]{0,90}$/.test(normalized) ? normalized : "";
}

async function isRegularNonSymlink(filePath) {
  const info = await lstat(filePath).catch((error) => skippableMetadataError(error) ? null : Promise.reject(error));
  return Boolean(info && !info.isSymbolicLink() && info.isFile());
}

async function readOptionalRegularUtf8(filePath, maxBytes) {
  const info = await lstat(filePath).catch((error) => skippableMetadataError(error) ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return null;
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)).catch((error) => skippableMetadataError(error) ? null : Promise.reject(error));
  if (!handle) return null;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) return null;
    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

function skippableMetadataError(error) {
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EBUSY"].includes(error?.code);
}

function safeSingleLine(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
