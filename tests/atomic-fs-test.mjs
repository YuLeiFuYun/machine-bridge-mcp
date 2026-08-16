import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientReplaceError, replaceFileSync } from "../src/local/atomic-fs.mjs";
import { publicError } from "../src/local/errors.mjs";
import { assertNoResolvedPatchCollisions, atomicWriteText, commitPatchTransaction, sha256 } from "../src/local/workspace-file-service.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-atomic-replace-test-"));
try {
  const source = join(root, "source.json");
  const target = join(root, "target.json");
  await writeFile(source, "new", "utf8");
  await writeFile(target, "old", "utf8");
  let calls = 0;
  const delays = [];
  const result = replaceFileSync(source, target, {
    baseDelayMs: 10,
    maxDelayMs: 250,
    random: () => 0,
    sleep: (milliseconds) => delays.push(milliseconds),
    rename(from, to) {
      calls += 1;
      if (calls <= 3) {
        const error = new Error("simulated transient sharing violation");
        error.code = calls % 2 ? "EPERM" : "EBUSY";
        throw error;
      }
      renameSync(from, to);
    },
  });
  assert(result.attempts === 4 && calls === 4, "transient replacement was not retried deterministically");
  assert(JSON.stringify(delays) === JSON.stringify([10, 20, 40]), "atomic replacement did not use bounded exponential backoff");
  assert(await readFile(target, "utf8") === "new", "replacement did not commit the new file");

  let extendedCalls = 0;
  const extended = replaceFileSync("source", "target", {
    baseDelayMs: 0,
    rename() {
      extendedCalls += 1;
      if (extendedCalls <= 24) {
        const error = new Error("simulated sustained Windows sharing violation");
        error.code = "EPERM";
        throw error;
      }
    },
  });
  assert(extended.attempts === 25 && extendedCalls === 25, "default replacement retry budget did not survive sustained transient contention");

  const missing = join(root, "missing.json");
  let nonTransientCalls = 0;
  expectThrow(() => replaceFileSync(missing, target, {
    rename() {
      nonTransientCalls += 1;
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  }), "missing");
  assert(nonTransientCalls === 1, "non-transient replacement error was retried");
  assert(isTransientReplaceError({ code: "EACCES" }) && !isTransientReplaceError({ code: "ENOENT" }), "transient error classification is incorrect");

  const caseAliasOne = { operation: { kind: "add" }, source: null, target: join(root, "Case-Alias.txt") };
  const caseAliasTwo = { operation: { kind: "add" }, source: null, target: join(root, "case-alias.txt") };
  const caseCollision = expectThrow(() => assertNoResolvedPatchCollisions([caseAliasOne, caseAliasTwo], "darwin"), "same path");
  assert(caseCollision?.code === "conflict" && caseCollision?.details?.reason === "resolved_path_collision",
    "Darwin resolved-path collision did not use the shared mutation identity or stable conflict reason");
  assertNoResolvedPatchCollisions([caseAliasOne, caseAliasTwo], "linux");

  const appearedTarget = join(root, "appeared-target.txt");
  let noOverwriteLinkCalls = 0;
  const appeared = await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "add", source: null, target: appearedTarget, content: "new", mode: 0o600,
  }], {
    async rename() { throw new Error("patch staged target unexpectedly used overwrite-capable rename"); },
    async link() {
      noOverwriteLinkCalls += 1;
      const error = new Error("simulated target alias appeared");
      error.code = "EEXIST";
      throw error;
    },
  }), "target appeared", "conflict", true, "target_appeared");
  assert(noOverwriteLinkCalls === 1 && appeared.cause?.code === "EEXIST",
    "patch target commit did not fail closed through the no-overwrite link primitive");

  const cleanupTarget = join(root, "cleanup-warning.txt");
  await writeFile(cleanupTarget, "old", { encoding: "utf8", mode: 0o600 });
  const cleanupResult = await commitPatchTransaction([{
    kind: "update",
    source: cleanupTarget,
    target: cleanupTarget,
    content: "new",
    originalHash: sha256("old"),
    mode: 0o600,
  }], {
    async remove(path, options) {
      if (path.includes(".mbm-backup-")) throw new Error("simulated backup cleanup failure");
      return rm(path, options);
    },
  });
  assert(await readFile(cleanupTarget, "utf8") === "new", "patch cleanup warning test did not commit content");
  assert(cleanupResult.warnings.length === 1 && cleanupResult.warnings[0].includes("Patch committed"), "committed patch cleanup failure was silently swallowed");

  const rollbackTarget = join(root, "rollback-warning.txt");
  await writeFile(rollbackTarget, "old", { encoding: "utf8", mode: 0o600 });
  const rollbackFailure = await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update",
    source: rollbackTarget,
    target: rollbackTarget,
    content: "new",
    originalHash: sha256("old"),
    mode: 0o600,
  }], {
    async rename(from, to) {
      if (from.includes(".mbm-backup-")) throw new Error("simulated rollback failure");
      return rename(from, to);
    },
    async link() { throw new Error("simulated commit failure"); },
  }), "recovery was incomplete", "execution_failed", true);
  const publicRollbackFailure = publicError(rollbackFailure);
  assert(rollbackFailure.retryable === false
    && rollbackFailure.details?.reason === "patch_recovery_incomplete"
    && publicRollbackFailure.retryable === false
    && publicRollbackFailure.message.includes("may have partially modified files")
    && publicRollbackFailure.message.includes("inspect affected paths before retrying"),
  "incomplete patch rollback was not exposed as a stable non-retryable unknown filesystem settlement");
  assert(rollbackFailure.cause instanceof AggregateError
    && rollbackFailure.cause.errors?.[0]?.message === "simulated commit failure"
    && rollbackFailure.cause.errors?.[1]?.message === "simulated rollback failure",
  "incomplete patch rollback did not preserve primary and cleanup causes in order");

  const rollbackCleanupTarget = join(root, "rollback-cleanup-only.txt");
  await writeFile(rollbackCleanupTarget, "old", { encoding: "utf8", mode: 0o600 });
  const rollbackCleanupFailure = await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update", source: rollbackCleanupTarget, target: rollbackCleanupTarget,
    content: "new", originalHash: sha256("old"), mode: 0o600,
  }], {
    async link() { throw new Error("simulated commit failure before target creation"); },
    async remove(path, options) {
      if (path.includes(".mbm-patch-")) throw new Error("simulated staging cleanup failure");
      return rm(path, options);
    },
  }), "staging cleanup was incomplete", "internal_error", false);
  assert(await readFile(rollbackCleanupTarget, "utf8") === "old"
    && rollbackCleanupFailure.details?.reason !== "patch_recovery_incomplete"
    && rollbackCleanupFailure.cause instanceof AggregateError
    && rollbackCleanupFailure.cause.errors?.[0]?.message === "simulated commit failure before target creation"
    && rollbackCleanupFailure.cause.errors?.[1]?.message === "simulated staging cleanup failure",
  "staging-artifact cleanup failure was incorrectly reported as ambiguous user-file rollback");

  const atomicCleanupTarget = join(root, "atomic-cleanup.txt");
  await writeFile(atomicCleanupTarget, "current", { encoding: "utf8", mode: 0o600 });
  const atomicCleanupFailure = await expectAsyncThrow(() => atomicWriteText(atomicCleanupTarget, "new", null, {
    expectedHash: sha256("stale"),
    async remove() { throw new Error("simulated atomic staging cleanup failure"); },
  }), "cleanup was incomplete", "internal_error", false);
  assert(atomicCleanupFailure.cause instanceof AggregateError
    && atomicCleanupFailure.cause.errors?.[0]?.code === "conflict"
    && atomicCleanupFailure.cause.errors?.[0]?.details?.reason === "hash_mismatch"
    && atomicCleanupFailure.cause.errors?.[1]?.message === "simulated atomic staging cleanup failure"
    && await readFile(atomicCleanupTarget, "utf8") === "current",
  "atomic pre-commit cleanup failure lost its primary conflict, cleanup cause, or target integrity");

  const createOnlyTarget = join(root, "create-only-cleanup-warning.txt");
  const createOnlyCommit = await atomicWriteText(createOnlyTarget, "committed", null, {
    createOnly: true,
    async remove() { throw new Error("simulated post-commit staging cleanup failure"); },
  });
  assert(await readFile(createOnlyTarget, "utf8") === "committed"
    && createOnlyCommit.warnings.length === 1 && createOnlyCommit.warnings[0].includes("File committed"),
  "create-only post-commit cleanup failure retroactively reported the committed mutation as failed");

  const staleTarget = join(root, "stale-source.txt");
  await writeFile(staleTarget, "current", { encoding: "utf8", mode: 0o600 });
  await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update",
    source: staleTarget,
    target: staleTarget,
    content: "new",
    originalHash: sha256("stale"),
    mode: 0o600,
  }]), "source changed", "conflict", true, "hash_mismatch");
  assert(await readFile(staleTarget, "utf8") === "current", "stale patch precondition modified the source file");

  const commitRaceTarget = join(root, "commit-generation-race.txt");
  await writeFile(commitRaceTarget, "observed", { encoding: "utf8", mode: 0o600 });
  let injectedCommitRace = false;
  await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "delete",
    source: commitRaceTarget,
    target: null,
    originalHash: sha256("observed"),
    mode: 0o600,
  }], {
    async rename(from, to) {
      if (from === commitRaceTarget && !injectedCommitRace) {
        injectedCommitRace = true;
        await writeFile(commitRaceTarget, "concurrent-generation", { encoding: "utf8", mode: 0o600 });
      }
      return rename(from, to);
    },
  }), "source changed during commit", "conflict", true, "hash_mismatch");
  assert(injectedCommitRace && await readFile(commitRaceTarget, "utf8") === "concurrent-generation",
    "patch delete removed or overwrote a source generation that changed between preflight and rename");

  const atomicRaceTarget = join(root, "atomic-generation-race.txt");
  await writeFile(atomicRaceTarget, "observed", { encoding: "utf8", mode: 0o600 });
  const atomicRaceInfo = await stat(atomicRaceTarget);
  let injectedAtomicRace = false;
  await expectAsyncThrow(() => atomicWriteText(atomicRaceTarget, "replacement", atomicRaceInfo, {
    expectedHash: sha256("observed"),
    async rename(from, to) {
      if (from === atomicRaceTarget && !injectedAtomicRace) {
        injectedAtomicRace = true;
        await writeFile(atomicRaceTarget, "concurrent-generation", { encoding: "utf8", mode: 0o600 });
      }
      return rename(from, to);
    },
  }), "source changed during commit", "conflict", true, "hash_mismatch");
  assert(injectedAtomicRace && await readFile(atomicRaceTarget, "utf8") === "concurrent-generation",
    "expected-hash atomic write overwrote a source generation that changed between preflight and rename");

  console.log("atomic file replacement and patch recovery test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return error;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectAsyncThrow(callback, pattern, code = "", expose = undefined, reason = "") {
  try { await callback(); } catch (error) {
    if (!String(error?.message || error).includes(pattern)) throw error;
    if (code && error?.code !== code) throw new Error(`expected ${code}, received ${error?.code || "untyped"}`);
    if (expose !== undefined && error?.expose !== expose) throw new Error(`expected expose=${expose}, received ${error?.expose}`);
    if (reason && error?.details?.reason !== reason) throw new Error(`expected reason ${reason}, received ${error?.details?.reason || "missing"}`);
    return error;
  }
  throw new Error(`expected async throw containing: ${pattern}`);
}
