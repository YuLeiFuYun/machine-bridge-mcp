import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";

const MAX_GIT_CONFIG_BYTES = 256 * 1024;

export async function assertStructuredGitConfigSafe({
  git,
  inspectWorkingTree = false,
  resolveExistingPath,
  runInternalProcess,
  gitExecutable,
  context = {},
  environment = {},
}) {
  const files = new Set([join(git.commonDir, "config"), join(git.gitDir, "config.worktree")]);
  for (const file of files) {
    const entry = await pathEntryIfExists(file);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || Number(entry.nlink) !== 1 || Number(entry.size) > MAX_GIT_CONFIG_BYTES) {
      throw unsafeConfigError();
    }
    const canonical = await resolveExistingPath(file, context);
    const result = await runInternalProcess(
      gitExecutable(),
      ["--no-pager", "config", "--file", canonical, "--no-includes", "--null", "--name-only", "--list"],
      10_000,
      true,
      MAX_GIT_CONFIG_BYTES,
      context,
      git.root,
      null,
      environment,
    );
    if (result.code !== 0) throw unsafeConfigError();
    const keys = String(result.stdout || "").split("\0").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (keys.some((key) => key.startsWith("include.") || key.startsWith("includeif.") || key === "core.attributesfile" || key === "diff.orderfile"
      || key === "extensions.partialclone" || /^remote\..+\.(?:promisor|partialclonefilter)$/.test(key))) {
      throw unsafeConfigError();
    }
    if (inspectWorkingTree && keys.some((key) => key === "core.excludesfile" || executableFilterKey(key))) {
      throw unsafeConfigError();
    }
  }
}

function executableFilterKey(key) {
  return /^filter\..+\.(?:clean|smudge|process)$/.test(key);
}

function unsafeConfigError() {
  return new BridgeError("authorization_denied", "repository Git configuration is incompatible with the structured Git safety boundary", {
    details: { reason: "unsafe_repository_git_config" },
  });
}
