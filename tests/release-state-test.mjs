import assert from "node:assert/strict";
import test from "node:test";
import { tagSyncError } from "../scripts/lib/release.mjs";

test("release state tag synchronization diagnostics distinguish local, remote, missing, and mismatched tags", () => {
  const head = "a".repeat(40);
  const other = "b".repeat(40);

  assert.equal(
    tagSyncError({ scope: "local", tag: "v1.2.3", head, commit: null }),
    "local tag v1.2.3 is missing; run the applicable GitHub release command before npm publish",
  );
  assert.equal(
    tagSyncError({ scope: "remote", tag: "v1.2.3", head, commit: null }),
    "remote tag v1.2.3 is missing; run the applicable GitHub release command before npm publish",
  );
  assert.equal(
    tagSyncError({ scope: "local", tag: "v1.2.3", head, commit: other }),
    `local tag v1.2.3 points to ${other}, not HEAD ${head}`,
  );
  assert.equal(tagSyncError({ scope: "remote", tag: "v1.2.3", head, commit: head }), "");
});
