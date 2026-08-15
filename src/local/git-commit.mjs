import { BridgeError } from "./errors.mjs";
import { assertStructuredGitCommitStateClear } from "./git-operation-state.mjs";

const GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function createStructuredGitCommit({ git, message, disabledHooksPath, runInternalProcess, gitExecutable, context = {}, environment = {} }) {
  const base = [
    "--no-pager",
    `--git-dir=${git.gitDir}`,
    `--work-tree=${git.root}`,
    "-c", "core.fsmonitor=false",
    "-c", "color.ui=false",
    "-c", `core.hooksPath=${disabledHooksPath}`,
    "-c", "commit.gpgSign=false",
  ];
  const run = (args, stdin = null) => runInternalProcess(
    gitExecutable(), [...base, ...args], 60_000, true, 64 * 1024, context, git.root, stdin, environment,
  );

  await assertStructuredGitCommitStateClear(git.gitDir);
  const treeResult = await run(["write-tree"]);
  const tree = requireHash(treeResult, "Git staged index could not be written");

  const headResult = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
  let oldHead = "";
  if (headResult.code === 0) oldHead = requireHash(headResult, "Git HEAD is invalid");

  const symbolic = await run(["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.code !== 0 && symbolic.code !== 1) throw commitFailure("Git HEAD could not be resolved", symbolic.code);
  const symbolicRef = symbolic.code === 0 ? String(symbolic.stdout || "").trim() : "";
  if (symbolicRef) {
    const refValidation = await run(["check-ref-format", symbolicRef]);
    if (refValidation.code !== 0) throw commitFailure("Git HEAD reference is invalid", refValidation.code);
  }
  if (!oldHead && !symbolicRef) throw commitFailure("Git repository has no commit parent or branch reference", headResult.code);

  if (oldHead) {
    const headTreeResult = await run(["rev-parse", "--verify", "HEAD^{tree}"]);
    const headTree = requireHash(headTreeResult, "Git HEAD tree is invalid");
    if (headTree === tree) throw commitFailure("Git staged index has no changes to commit", 1, "git_commit_empty");
  }

  const commitArgs = ["commit-tree", tree];
  if (oldHead) commitArgs.push("-p", oldHead);
  commitArgs.push("-F", "-");
  const commitResult = await run(commitArgs, message);
  const commit = requireHash(commitResult, "Git commit object could not be created");

  const targetRef = symbolicRef || "HEAD";
  const expected = oldHead || "0".repeat(tree.length);
  const updateResult = await run(["update-ref", "-m", "machine-bridge-mcp structured commit", targetRef, commit, expected]);
  if (updateResult.code !== 0) {
    throw commitFailure("Git history changed concurrently or the reference update failed", updateResult.code, "git_commit_conflict");
  }
  return Object.freeze({ committed: true });
}

function requireHash(result, message) {
  if (result.code !== 0) throw commitFailure(message, result.code);
  const value = String(result.stdout || "").trim();
  if (!GIT_HASH.test(value)) throw commitFailure(message, result.code);
  return value;
}

function commitFailure(message, code, reason = "git_commit_failed") {
  return new BridgeError("execution_failed", message, {
    details: { reason, code: Number.isInteger(code) ? code : 1 },
  });
}
