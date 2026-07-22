import path from "node:path";
import { resolveTrustedExecutable } from "./trusted-executable.mjs";

export function resolveTrustedGithubCli(options = {}) {
  const platform = String(options.platform || process.platform);
  return resolveTrustedExecutable({
    ...options,
    platform,
    label: "GitHub CLI executable",
    reason: "trusted_github_cli_unavailable",
    candidates: Array.isArray(options.candidates) ? options.candidates : githubCliCandidates(platform, options.env || process.env),
  });
}

function githubCliCandidates(platform, env) {
  if (platform === "win32") {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, "GitHub CLI", "gh.exe"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"),
    ].filter(Boolean);
  }
  if (platform === "darwin") return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  return ["/usr/bin/gh", "/usr/local/bin/gh", "/snap/bin/gh"];
}
