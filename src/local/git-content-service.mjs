import { BridgeError } from "./errors.mjs";
import { clampInteger } from "./numbers.mjs";
import { filterSensitiveGitPaths } from "./git-sensitive-path-filter.mjs";

export function gitCommandPrefix(git) {
  return [
    "--no-pager",
    "--literal-pathspecs",
    `--git-dir=${git.gitDir}`,
    `--work-tree=${git.root}`,
    "-c", "core.fsmonitor=false",
    "-c", "color.ui=false",
  ];
}

export async function structuredGitDiff({
  args, context, git, maximumBytes, displayPath, runInternalProcess, gitExecutable, environment,
}) {
  const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, maximumBytes);
  const commandArgs = [...gitCommandPrefix(git), "-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];
  if (args.staged) commandArgs.push("--cached");
  let omittedSensitiveFiles = 0;
  if (isDelegatedRelayContext(context)) {
    const filtered = await filterSensitiveGitPaths({
      target: git.target, root: git.root, context, commandArgs: [...commandArgs, "--name-status", "-z"],
      pathspec: git.pathspec, gitExecutable, runInternalProcess, environment,
    });
    if (!filtered.ok) return { code: filtered.code, stdout: "", stderr: filtered.stderr, path: displayPath(git.target, context), gitRoot: displayPath(git.root, context), staged: args.staged === true };
    omittedSensitiveFiles = filtered.omittedSensitiveFiles;
    if (!filtered.paths.length) {
      return { code: 0, stdout: "", stderr: "", path: displayPath(git.target, context), gitRoot: displayPath(git.root, context), staged: args.staged === true, ...(omittedSensitiveFiles ? { sensitive_files_omitted: omittedSensitiveFiles } : {}) };
    }
    commandArgs.push("--", ...filtered.paths);
  } else if (git.pathspec) commandArgs.push("--", git.pathspec);
  const result = await runInternalProcess(
    gitExecutable, commandArgs, 60_000, true, maxBytes, context, git.root, null, environment,
  );
  return {
    ...result, path: displayPath(git.target, context), gitRoot: displayPath(git.root, context),
    staged: args.staged === true, ...(omittedSensitiveFiles ? { sensitive_files_omitted: omittedSensitiveFiles } : {}),
  };
}

export async function structuredGitShow({
  args, context, git, maximumBytes, displayPath, runInternalProcess, gitExecutable, environment,
}) {
  const revision = validateRevision(args.revision || "HEAD");
  const maxBytes = clampInteger(args.max_bytes, 1024 * 1024, 1, maximumBytes);
  const commandArgs = [...gitCommandPrefix(git), "-c", "diff.external=", "-c", "log.showSignature=false", "show", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--ignore-submodules=all", "--decorate=no", revision];
  let omittedSensitiveFiles = 0;
  if (isDelegatedRelayContext(context)) {
    const nameArgs = [...gitCommandPrefix(git), "-c", "diff.external=", "show", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--ignore-submodules=all", "--format=", "--name-status", "-z", revision];
    const filtered = await filterSensitiveGitPaths({
      target: git.target, root: git.root, context, commandArgs: nameArgs,
      pathspec: git.pathspec, gitExecutable, runInternalProcess, environment,
    });
    if (!filtered.ok) return { code: filtered.code, stdout: "", stderr: filtered.stderr, revision, path: displayPath(git.target, context), gitRoot: displayPath(git.root, context) };
    omittedSensitiveFiles = filtered.omittedSensitiveFiles;
    if (!filtered.paths.length) {
      return { code: 0, stdout: "", stderr: "", revision, path: displayPath(git.target, context), gitRoot: displayPath(git.root, context), ...(omittedSensitiveFiles ? { sensitive_files_omitted: omittedSensitiveFiles } : {}) };
    }
    commandArgs.push("--", ...filtered.paths);
  } else if (git.pathspec) commandArgs.push("--", git.pathspec);
  const result = await runInternalProcess(
    gitExecutable, commandArgs, 60_000, true, maxBytes, context, git.root, null, environment,
  );
  return { ...result, revision, path: displayPath(git.target, context), gitRoot: displayPath(git.root, context), ...(omittedSensitiveFiles ? { sensitive_files_omitted: omittedSensitiveFiles } : {}) };
}

function isDelegatedRelayContext(context) {
  const authority = context?.authority;
  const principal = authority?.principal;
  return context?.origin === "relay" && principal?.kind === "account"
    && principal.role !== "owner" && authority.owner !== true;
}

function validateRevision(value) {
  const revision = String(value || "HEAD");
  if (!revision || revision.length > 256 || revision.startsWith("-") || revision.includes("\0") || /[\r\n]/.test(revision)) {
    throw new BridgeError("invalid_request", "invalid Git revision");
  }
  return revision;
}
