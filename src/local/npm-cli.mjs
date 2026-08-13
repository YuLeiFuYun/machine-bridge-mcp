import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function resolveNpmCli(options = {}) {
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const nodeExecutable = path.resolve(String(options.nodeExecutable || process.execPath));
  const nodeDirectory = path.dirname(nodeExecutable);
  const packageManagerPrefix = nodePackageManagerPrefix(nodeExecutable);
  const candidates = [
    options.npmCli,
    ...(options.allowLifecycleNpmCli === false ? [] : [env.npm_execpath]),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    packageManagerPrefix && path.join(packageManagerPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(options.allowFallbackLocations === false ? [] : [
      env.ProgramFiles && path.join(env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
      "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js",
    ]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(String(candidate))) continue;
    try {
      const canonical = realpathSync(String(candidate));
      const info = statSync(canonical);
      if (!info.isFile()) continue;
      if (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0) continue;
      return canonical;
    } catch {
      // Candidate discovery is bounded and failure of one conventional location is irrelevant.
    }
  }
  throw new Error("npm 12 CLI could not be located; install npm 12 alongside Node.js 26 and retry");
}

function nodePackageManagerPrefix(nodeExecutable) {
  const marker = `${path.sep}Cellar${path.sep}`;
  const index = nodeExecutable.indexOf(marker);
  return index > 0 ? nodeExecutable.slice(0, index) : "";
}
