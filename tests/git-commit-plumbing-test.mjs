import { createStructuredGitCommit } from "../src/local/git-commit.mjs";

const head = "a".repeat(40);
const tree = "b".repeat(40);
const commit = "c".repeat(40);
const git = { gitDir: "/synthetic/.git", root: "/synthetic" };

await succeeds({ symbolic: { code: 1, stdout: "" } }, (calls) => {
  const update = calls.find((call) => call.args.includes("update-ref"));
  const create = calls.find((call) => call.args.includes("commit-tree"));
  assert(update?.args.includes("HEAD") && create?.args.includes("-p") && create?.args.includes(head),
    "detached structured commit lost HEAD targeting or parent linkage");
});
await fails({ symbolic: { code: 2, stdout: "" } }, "git_commit_failed");
await fails({ headResult: { code: 1, stdout: "" }, symbolic: { code: 1, stdout: "" } }, "git_commit_failed");
await fails({ refValidation: { code: 1, stdout: "" } }, "git_commit_failed");
await fails({ treeResult: { code: 1, stdout: "" } }, "git_commit_failed");
await fails({ treeResult: { code: 0, stdout: "not-a-hash" } }, "git_commit_failed");
await fails({ commitResult: { code: 0, stdout: "not-a-hash" } }, "git_commit_failed");
await fails({ updateResult: { code: 1, stdout: "" } }, "git_commit_conflict");

console.log("structured Git commit plumbing test ok");

async function succeeds(overrides, inspect) {
  const calls = [];
  const result = await createStructuredGitCommit(fixture(overrides, calls));
  assert(result.committed === true, "synthetic structured commit did not report success");
  inspect?.(calls);
}

async function fails(overrides, reason) {
  const calls = [];
  let error;
  try { await createStructuredGitCommit(fixture(overrides, calls)); }
  catch (caught) { error = caught; }
  assert(error?.code === "execution_failed" && error?.details?.reason === reason,
    `structured commit failure did not preserve ${reason}`);
  return { error, calls };
}

function fixture(overrides, calls) {
  const responses = {
    treeResult: { code: 0, stdout: tree },
    headResult: { code: 0, stdout: head },
    symbolic: { code: 0, stdout: "refs/heads/main\n" },
    refValidation: { code: 0, stdout: "" },
    headTreeResult: { code: 0, stdout: "d".repeat(40) },
    commitResult: { code: 0, stdout: commit },
    updateResult: { code: 0, stdout: "" },
    ...overrides,
  };
  return {
    git,
    message: "fix: synthetic plumbing",
    disabledHooksPath: "/synthetic/no-hooks",
    gitExecutable: () => "/usr/bin/git",
    context: {},
    environment: {},
    runInternalProcess: async (_command, args, _timeout, _allowFailure, _maxBytes, _context, _cwd, stdin) => {
      calls.push({ args: [...args], stdin });
      if (args.includes("write-tree")) return responses.treeResult;
      if (args.includes("symbolic-ref")) return responses.symbolic;
      if (args.includes("check-ref-format")) return responses.refValidation;
      if (args.includes("commit-tree")) return responses.commitResult;
      if (args.includes("update-ref")) return responses.updateResult;
      const revision = args.at(-1);
      if (revision === "HEAD^{commit}") return responses.headResult;
      if (revision === "HEAD^{tree}") return responses.headTreeResult;
      throw new Error(`unexpected synthetic Git command: ${args.join(" ")}`);
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
