// @ts-check

import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";

const IN_PROGRESS_HISTORY_MARKERS = Object.freeze([
  "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer",
]);

/** @param {string} gitDir */
export async function assertStructuredGitCommitStateClear(gitDir) {
  for (const marker of IN_PROGRESS_HISTORY_MARKERS) {
    if (!await pathEntryIfExists(join(gitDir, marker))) continue;
    throw new BridgeError("execution_failed", "Git commit is unavailable while a merge, rebase, cherry-pick, revert, or bisect operation is in progress", {
      details: { reason: "git_commit_repository_state", code: 1 },
    });
  }
}
