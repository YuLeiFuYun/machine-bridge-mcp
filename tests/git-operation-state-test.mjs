import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStructuredGitCommitStateClear } from "../src/local/git-operation-state.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-git-operation-state-"));
const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"];

try {
  const clear = join(root, "clear");
  await mkdir(clear);
  await assertStructuredGitCommitStateClear(clear);

  for (const marker of markers) {
    const gitDir = join(root, marker.toLowerCase().replaceAll("_", "-"));
    await mkdir(gitDir);
    const path = join(gitDir, marker);
    if (marker === marker.toUpperCase()) await writeFile(path, "synthetic\n");
    else await mkdir(path);
    const failure = await rejected(() => assertStructuredGitCommitStateClear(gitDir));
    assert(failure.code === "execution_failed" && failure.details?.reason === "git_commit_repository_state",
      `structured Git commit state boundary did not reject ${marker}`);
  }

  console.log("structured Git operation state test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function rejected(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected operation to be rejected");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
