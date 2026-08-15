import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitMetadataBoundary } from "../src/local/git-metadata-boundary.mjs";
import { assertGitMetadataTreesSafe } from "../src/local/git-metadata-tree-safety.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-git-tree-safety-"));
try {
  const regular = join(root, "regular");
  await writeFile(regular, "x\n");
  assert(await assertGitMetadataTreesSafe([regular]) === 0, "regular metadata root was not treated as a bounded leaf");
  const dir = join(root, "tree");
  await mkdir(dir);
  await writeFile(join(dir, "one"), "1\n");
  await writeFile(join(dir, "two"), "2\n");
  const limitFailure = await rejected(() => assertGitMetadataTreesSafe([dir], { maximumEntries: 1 }));
  assert(limitFailure?.code === "limit_exceeded", "metadata-tree entry ceiling did not fail closed");
  let typeFailure;
  try { await assertGitMetadataTreesSafe([dir], { maximumEntries: 0 }); } catch (error) { typeFailure = error; }
  assert(typeFailure instanceof TypeError, "invalid metadata-tree ceiling did not reject before traversal");
  const cancellation = new AbortController();
  const cancellationReason = new Error("synthetic metadata cancellation");
  cancellation.abort(cancellationReason);
  const cancellationFailure = await rejected(() => assertGitMetadataTreesSafe([dir], { signal: cancellation.signal }));
  assert(cancellationFailure === cancellationReason, "metadata-tree cancellation did not preserve the runtime cancellation reason");
  const opaqueCancellation = new AbortController();
  opaqueCancellation.abort("synthetic");
  const opaqueFailure = await rejected(() => assertGitMetadataTreesSafe([dir], { signal: opaqueCancellation.signal }));
  assert(opaqueFailure?.code === "cancelled", "metadata-tree cancellation without an Error reason was not bounded");

  const invalidGitDir = join(root, "invalid-gitdir");
  await mkdir(invalidGitDir);
  await writeFile(join(invalidGitDir, "objects"), "not-a-directory\n");
  const metadataFailure = await rejected(() => resolveGitMetadataBoundary({
    gitDir: invalidGitDir,
    commonDir: invalidGitDir,
    resolveExistingPath: async (value) => value,
  }));
  assert(metadataFailure?.code === "path_boundary" && metadataFailure?.details?.reason === "git_metadata_boundary",
    "invalid object-store shape did not use the Git metadata-boundary classifier");
  console.log("Git metadata tree safety test ok");
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
