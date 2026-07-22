import path from "node:path";
import { createTrustedExecutableResolver, resolveTrustedExecutable } from "./trusted-executable.mjs";

export function resolveTrustedGitExecutable(options = {}) {
  const platform = String(options.platform || process.platform);
  return resolveTrustedExecutable({
    ...options,
    platform,
    label: "Git executable",
    reason: "trusted_git_executable_unavailable",
    candidates: Array.isArray(options.candidates) ? options.candidates : defaultGitCandidates(platform, options.env || process.env),
  });
}

export function createTrustedGitResolver(options = {}) {
  const platform = String(options.platform || process.platform);
  return createTrustedExecutableResolver({
    ...options,
    platform,
    label: "Git executable",
    reason: "trusted_git_executable_unavailable",
    candidates: Array.isArray(options.candidates) ? options.candidates : defaultGitCandidates(platform, options.env || process.env),
  });
}

function defaultGitCandidates(platform, env) {
  if (platform === "win32") {
    return [env.ProgramFiles, env["ProgramFiles(x86)"]]
      .filter(Boolean)
      .flatMap((root) => [path.join(root, "Git", "cmd", "git.exe"), path.join(root, "Git", "bin", "git.exe")]);
  }
  if (platform === "darwin") return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
}
