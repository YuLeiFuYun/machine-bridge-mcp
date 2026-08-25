import { tagSyncError } from "../scripts/release-state.mjs";

const head = "a".repeat(40);
const other = "b".repeat(40);

assert(
  tagSyncError({ scope: "local", tag: "v1.2.3", head, commit: null })
    === "local tag v1.2.3 is missing; run the applicable GitHub release command before npm publish",
  "missing local tag did not produce the release-order guidance",
);
assert(
  tagSyncError({ scope: "remote", tag: "v1.2.3", head, commit: null })
    === "remote tag v1.2.3 is missing; run the applicable GitHub release command before npm publish",
  "missing remote tag did not identify the remote scope",
);
assert(
  tagSyncError({ scope: "local", tag: "v1.2.3", head, commit: other })
    === `local tag v1.2.3 points to ${other}, not HEAD ${head}`,
  "mismatched tag did not report both commits",
);
assert(
  tagSyncError({ scope: "remote", tag: "v1.2.3", head, commit: head }) === "",
  "synchronized tag produced a false error",
);

console.log("release state diagnostic test ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
