import { link, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTransientFilesystemMutationError, isTransientReplaceError, removePathSync, replaceFileSync,
} from "../src/local/atomic-fs.mjs";
import { publicError } from "../src/local/errors.mjs";
import { WorkspaceFileService, assertNoResolvedPatchCollisions, atomicWriteText, commitPatchTransaction, sha256 } from "../src/local/workspace-file-service.mjs";
import { renameWithRetry } from "../src/local/workspace-file-rename-retry.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-atomic-replace-test-"));
try {
  const service = new WorkspaceFileService({
    workspace: root, policyGate: { assert() {} }, throwIfCancelled() {},
    resolveExistingPath: async name => join(root, name), resolveWritePath: async name => join(root, name), displayPath: name => name,
    withMutationPaths: async (_paths, run) => run(),
  });
  const literalReplacement = ["$&", "$$", "$'", "$" + String.fromCharCode(96), "中文🙂"].join("|");
  for (const replaceAll of [false, true]) {
    const name = replaceAll ? "literal-all.txt" : "literal-once.txt";
    const original = replaceAll ? "beforeTOKENmiddleTOKENafter" : "beforeTOKENafter";
    await writeFile(join(root, name), original, "utf8");
    const edited = await service.editFile({ path: name, old_text: "TOKEN", new_text: literalReplacement, replace_all: replaceAll });
    const expected = original.split("TOKEN").join(literalReplacement);
    assert(await readFile(join(root, name), "utf8") === expected && edited.sha256 === sha256(expected),
      "literal edit expanded replacement tokens instead of preserving the requested text");
    assert(edited.replacements === (replaceAll ? 2 : 1), "literal edit returned an incorrect occurrence count");
  }


  const bomName = "bom.txt", bomText = "\uFEFFTOKEN中文🙂";
  const writtenBom = await service.writeFile({ path: bomName, content: bomText });
  const readBom = await service.readFile({ path: bomName });
  assert(readBom.content === bomText && readBom.sha256 === writtenBom.sha256 && readBom.sha256 === sha256(bomText),
    "UTF-8 read lost the leading BOM or changed the committed byte hash");
  const editedBom = await service.editFile({ path: bomName, old_text: "TOKEN", new_text: "changed", expected_sha256: writtenBom.sha256 });
  assert(await readFile(join(root, bomName), "utf8") === bomText.replace("TOKEN", "changed")
    && editedBom.sha256 === sha256(bomText.replace("TOKEN", "changed")), "unchanged BOM file failed its write/read/edit hash precondition");
  assert(!(await readdir(root)).some((name) => name.startsWith(`.${bomName}.mbm-backup-`)),
    "single-file edit left a transaction backup after atomic replacement");

  let failStagingCleanup = true;
  let failBackupCleanup = false;
  const warningService = new WorkspaceFileService({
    workspace: root, policyGate: { assert() {} }, throwIfCancelled() {},
    resolveExistingPath: async (name) => join(root, name), resolveWritePath: async (name) => join(root, name), displayPath: (name) => name,
    withMutationPaths: async (_paths, run) => run(),
    fileTransactionOptions: {
      async remove(target, options) {
        if (failStagingCleanup && target.includes(".mbm-") && target.endsWith(".tmp")) throw new Error("synthetic staging cleanup failure");
        if (failBackupCleanup && target.includes(".mbm-backup-")) throw new Error("synthetic backup cleanup failure");
        return rm(target, options);
      },
    },
  });
  const warnedWrite = await warningService.writeFile({ path: "write-warning.txt", content: "committed", create_only: true });
  assert(await readFile(join(root, "write-warning.txt"), "utf8") === "committed"
    && warnedWrite.warnings?.length === 1 && warnedWrite.warnings[0].includes("File committed"),
  "write_file hid a post-commit staging cleanup warning or implied the committed file was not written");

  failStagingCleanup = false;
  failBackupCleanup = true;
  await writeFile(join(root, "patch-warning.txt"), "old\n", { encoding: "utf8", mode: 0o600 });
  const warnedPatch = await warningService.applyPatch({ patch: "*** Begin Patch\n*** Update File: patch-warning.txt\n@@\n-old\n+new\n*** End Patch" });
  assert(await readFile(join(root, "patch-warning.txt"), "utf8") === "new\n"
    && warnedPatch.warnings?.length === 1 && warnedPatch.warnings[0].includes("Patch committed"),
  "apply_patch hid a post-commit backup cleanup warning or implied the committed file was not written");

  failBackupCleanup = false;
  await writeFile(join(root, "edit-warning.txt"), "old\n", { encoding: "utf8", mode: 0o600 });
  const warnedEdit = await warningService.editFile({ path: "edit-warning.txt", old_text: "old", new_text: "new" });
  assert(await readFile(join(root, "edit-warning.txt"), "utf8") === "new\n"
    && warnedEdit.ok === true && warnedEdit.warnings === undefined
    && !(await readdir(root)).some((name) => name.startsWith(".edit-warning.txt.mbm-backup-")),
  "edit_file did not settle cleanly after the backup-free atomic replacement");

  for (const replaceBeforeConfirmation of [false, true]) {
    const custodyTarget = join(root, replaceBeforeConfirmation ? "confirmation-replacement.txt" : "rollback-replacement.txt");
    const custodySecond = join(root, "custody-second.txt");
    let calls = 0;
    const custodyFailure = await expectAsyncThrow(() => commitPatchTransaction([
      { kind: "add", target: custodyTarget, content: "staged", mode: 0o600 },
      { kind: "add", target: custodySecond, content: "second", mode: 0o600 },
    ], { async link(from, to) {
      calls += 1;
      if (replaceBeforeConfirmation && calls === 1) {
        await link(from, to); await rm(to); await writeFile(to, "valuable replacement", { mode: 0o600 }); return;
      }
      if (calls === 2) {
        await rm(custodyTarget); await writeFile(custodyTarget, "valuable replacement", { mode: 0o600 });
        throw new Error("synthetic later commit failure");
      }
      return link(from, to);
    } }), "recovery was incomplete", "execution_failed", true, "patch_recovery_incomplete");
    assert(await readFile(custodyTarget, "utf8") === "valuable replacement" && custodyFailure.retryable === false,
      "transaction rollback removed a concurrently replaced target or invited blind replay");
  }

  const custodySource = join(root, "restore-source-replacement.txt");
  await writeFile(custodySource, "original", { mode: 0o600 });
  await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update", source: custodySource, target: custodySource, content: "update", originalHash: sha256("original"), mode: 0o600,
  }], { async link() {
    await writeFile(custodySource, "valuable new source", { flag: "wx", mode: 0o600 });
    throw new Error("synthetic commit failure");
  } }), "recovery was incomplete", "execution_failed", true, "patch_recovery_incomplete");
  const preservedBackups = (await readdir(root)).filter(name => name.startsWith(".restore-source-replacement.txt.mbm-backup-"));
  assert(await readFile(custodySource, "utf8") === "valuable new source" && preservedBackups.length === 1
    && await readFile(join(root, preservedBackups[0]), "utf8") === "original",
  "transaction rollback overwrote a new source or discarded its original recovery snapshot");


  const changedBackupSource = join(root, "changed-backup-source.txt");
  await writeFile(changedBackupSource, "original backup", { mode: 0o600 });
  await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update", source: changedBackupSource, target: changedBackupSource,
    content: "update", originalHash: sha256("original backup"), mode: 0o600,
  }], { async link() {
    const backupName = (await readdir(root)).find(name => name.startsWith(".changed-backup-source.txt.mbm-backup-"));
    await rm(join(root, backupName)); await writeFile(join(root, backupName), "valuable backup replacement", { mode: 0o600 });
    throw new Error("synthetic commit failure after backup replacement");
  } }), "recovery was incomplete", "execution_failed", true, "patch_recovery_incomplete");
  const changedBackupName = (await readdir(root)).find(name => name.startsWith(".changed-backup-source.txt.mbm-backup-"));
  assert(await readFile(join(root, changedBackupName), "utf8") === "valuable backup replacement",
    "rollback consumed or changed a replacement recovery artifact");

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

  let removeCalls = 0;
  const removeDelays = [];
  const removed = removePathSync(join(root, "transient-remove"), {
    force: true,
    baseDelayMs: 10,
    maxDelayMs: 250,
    random: () => 0,
    sleep: (milliseconds) => removeDelays.push(milliseconds),
    remove() {
      removeCalls += 1;
      if (removeCalls <= 3) {
        const error = new Error("simulated transient Windows deletion contention");
        error.code = removeCalls % 2 ? "EPERM" : "EBUSY";
        throw error;
      }
    },
  });
  assert(removed.attempts === 4 && removed.removed === true && removeCalls === 4,
    "transient filesystem removal was not retried deterministically");
  assert(JSON.stringify(removeDelays) === JSON.stringify([10, 20, 40]),
    "filesystem removal did not use bounded exponential backoff");
  const alreadyMissing = removePathSync(join(root, "already-missing"), {
    force: true,
    remove() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert(alreadyMissing.removed === false && alreadyMissing.attempts === 1,
    "forced filesystem removal did not preserve idempotent ENOENT settlement");
  let removeNonTransientCalls = 0;
  expectThrow(() => removePathSync(join(root, "invalid-remove"), {
    force: true,
    remove() {
      removeNonTransientCalls += 1;
      throw Object.assign(new Error("invalid"), { code: "EINVAL" });
    },
  }), "invalid");
  assert(removeNonTransientCalls === 1 && isTransientFilesystemMutationError({ code: "EPERM" })
    && !isTransientFilesystemMutationError({ code: "EINVAL" }),
  "filesystem removal retry broadened beyond transient mutation failures");

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
    async restoreLink() { throw new Error("simulated rollback failure"); },
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

  const interruptedTarget = join(root, "interrupted-atomic-write.txt");
  await writeFile(interruptedTarget, "old", { encoding: "utf8", mode: 0o600 });
  const transactionModuleUrl = new URL("../src/local/workspace-file-transaction.mjs", import.meta.url).href;
  const interruptedScript = `
    import { atomicWriteText, sha256 } from ${JSON.stringify(transactionModuleUrl)};
    await atomicWriteText(${JSON.stringify(interruptedTarget)}, "new", { mode: 0o600 }, {
      expectedHash: sha256("old"),
      readText: async () => { process.exit(71); },
    });
  `;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", interruptedScript], {
    cwd: process.cwd(), encoding: "utf8",
  });
  const interruptedStaging = (await readdir(root)).filter((name) => name.startsWith(".interrupted-atomic-write.txt.mbm-") && name.endsWith(".tmp"));
  assert(interrupted.status === 71 && await readFile(interruptedTarget, "utf8") === "old" && interruptedStaging.length === 1,
    "process interruption before the atomic rename left the destination missing or changed");

  const committedBeforeExitTarget = join(root, "committed-before-exit.txt");
  await writeFile(committedBeforeExitTarget, "old", { encoding: "utf8", mode: 0o600 });
  const committedBeforeExitScript = `
    import { rename } from "node:fs/promises";
    import { atomicWriteText, sha256 } from ${JSON.stringify(transactionModuleUrl)};
    await atomicWriteText(${JSON.stringify(committedBeforeExitTarget)}, "new", { mode: 0o600 }, {
      expectedHash: sha256("old"),
      readText: (filePath) => import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8")),
      rename: async (source, target) => {
        await rename(source, target);
        if (target === ${JSON.stringify(committedBeforeExitTarget)}) process.exit(72);
      },
    });
  `;
  const committedBeforeExit = spawnSync(process.execPath, ["--input-type=module", "-e", committedBeforeExitScript], {
    cwd: process.cwd(), encoding: "utf8",
  });
  const committedStaging = (await readdir(root)).filter((name) => name.startsWith(".committed-before-exit.txt.mbm-") && name.endsWith(".tmp"));
  assert(committedBeforeExit.status === 72 && await readFile(committedBeforeExitTarget, "utf8") === "new" && committedStaging.length === 0,
    "process interruption after atomic replacement did not leave a complete committed target");

  const patchCrashTarget = join(root, "patch-crash-window.txt");
  await writeFile(patchCrashTarget, "old", { encoding: "utf8", mode: 0o600 });
  const patchCrashScript = `
    import { readFile, rename } from "node:fs/promises";
    import { commitPatchTransaction, sha256 } from ${JSON.stringify(transactionModuleUrl)};
    const target = ${JSON.stringify(patchCrashTarget)};
    await commitPatchTransaction([{
      kind: "update", source: target, target, content: "new",
      originalHash: sha256("old"), mode: 0o600,
    }], {
      readText: (filePath) => readFile(filePath, "utf8"),
      rename: async (from, to) => {
        await rename(from, to);
        if (from === target && to.includes(".mbm-backup-")) process.exit(73);
      },
    });
  `;
  const patchCrash = spawnSync(process.execPath, ["--input-type=module", "-e", patchCrashScript], {
    cwd: process.cwd(), encoding: "utf8",
  });
  const patchCrashArtifacts = await readdir(root);
  const patchCrashBackup = patchCrashArtifacts.find((name) => name.startsWith(".patch-crash-window.txt.mbm-backup-"));
  const patchCrashStaging = patchCrashArtifacts.filter((name) => name.startsWith(".patch-crash-window.txt.mbm-patch-") && name.endsWith(".tmp"));
  assert(patchCrash.status === 73 && !patchCrashArtifacts.includes("patch-crash-window.txt")
      && patchCrashBackup && patchCrashStaging.length === 1
      && await readFile(join(root, patchCrashBackup), "utf8") === "old",
    "multi-file patch crash window was not reproducible: source should be recoverable from its retained backup while the target is temporarily absent");

  const visibleTarget = join(root, "continuously-visible.txt");
  await writeFile(visibleTarget, "initial", { encoding: "utf8", mode: 0o600 });
  const readFailures = [];
  const readers = Array.from({ length: 4 }, async () => {
    for (let index = 0; index < 100; index += 1) {
      try { await readFile(visibleTarget, "utf8"); }
      catch (error) { readFailures.push(error?.code || String(error)); }
    }
  });
  for (let index = 0; index < 20; index += 1) {
    await atomicWriteText(visibleTarget, `version-${index}`, { mode: 0o600 });
  }
  await Promise.all(readers);
  assert(readFailures.length === 0, `atomic replacement exposed a missing destination to readers: ${readFailures.join(",")}`);

  const retrySource = join(root, "transient-retry-source.txt");
  const retryTarget = join(root, "transient-retry-target.txt");
  await writeFile(retrySource, "replacement", "utf8");
  let renameAttempts = 0;
  const retryResult = await renameWithRetry(retrySource, retryTarget, async (source, target) => {
    renameAttempts += 1;
    if (renameAttempts < 3) throw Object.assign(new Error("transient sharing violation"), { code: "EPERM" });
    await rename(source, target);
  }, { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 });
  assert(retryResult.attempts === 3 && renameAttempts === 3 && await readFile(retryTarget, "utf8") === "replacement",
    "atomic replacement did not retry a transient filesystem sharing violation");

  for (const [code, expectedAttempts] of [["EPERM", 4], ["EIO", 1]]) {
    const failure = Object.assign(new Error("injected rename failure"), { code });
    let attempts = 0;
    let caught;
    try {
      await renameWithRetry(retrySource, retryTarget, async () => {
        attempts += 1;
        throw failure;
      }, { attempts: 4, baseDelayMs: 0, maxDelayMs: 0 });
    } catch (error) { caught = error; }
    assert(caught === failure && attempts === expectedAttempts,
      "atomic replacement exceeded its retry bound or retried a non-transient failure");
  }

  const integratedRetryTarget = join(root, "integrated-retry-target.txt");
  await writeFile(integratedRetryTarget, "old", "utf8");
  let integratedAttempts = 0;
  await atomicWriteText(integratedRetryTarget, "replacement", { mode: 0o600 }, {
    async rename(source, target) {
      integratedAttempts += 1;
      if (integratedAttempts < 3) throw Object.assign(new Error("transient sharing violation"), { code: "EPERM" });
      await rename(source, target);
    },
  });
  assert(integratedAttempts === 3 && await readFile(integratedRetryTarget, "utf8") === "replacement",
    "workspace atomic replacement did not use the bounded retry");

  const retryRaceTarget = join(root, "retry-precondition-target.txt");
  await writeFile(retryRaceTarget, "observed", "utf8");
  let retryRaceAttempts = 0;
  await expectAsyncThrow(() => atomicWriteText(retryRaceTarget, "replacement", { mode: 0o600 }, {
    expectedHash: sha256("observed"),
    readText: (filePath) => readFile(filePath, "utf8"),
    async rename(source, target) {
      retryRaceAttempts += 1;
      if (retryRaceAttempts === 1) {
        await writeFile(target, "external-generation", "utf8");
        throw Object.assign(new Error("transient sharing violation"), { code: "EPERM" });
      }
      await rename(source, target);
    },
  }), "file changed before atomic commit", "conflict", true, "hash_mismatch");
  assert(retryRaceAttempts === 1 && await readFile(retryRaceTarget, "utf8") === "external-generation",
    "atomic replacement retry overwrote a generation that changed after the initial precondition check");
  assert(!(await readdir(root)).some((name) => name.startsWith(".retry-precondition-target.txt.mbm-")),
    "atomic replacement conflict during retry retained its staging artifact");

  const atomicRaceTarget = join(root, "atomic-generation-race.txt");
  await writeFile(atomicRaceTarget, "observed", { encoding: "utf8", mode: 0o600 });
  // atomicWriteText only needs the preserved permission bits here. Supplying
  // the known fixture mode keeps this race injection focused on the
  // transaction's hash generation rather than creating a test-side
  // stat-then-write pattern that static analyzers correctly classify as a
  // filesystem race in ordinary application code.
  const atomicRaceInfo = { mode: 0o600 };
  let injectedAtomicRace = false;
  await expectAsyncThrow(() => atomicWriteText(atomicRaceTarget, "replacement", atomicRaceInfo, {
    expectedHash: sha256("observed"),
    async readText(filePath) {
      if (filePath === atomicRaceTarget && !injectedAtomicRace) {
        injectedAtomicRace = true;
        await writeFile(filePath, "concurrent-generation", { encoding: "utf8", mode: 0o600 });
      }
      return readFile(filePath, "utf8");
    },
  }), "file changed before atomic commit", "conflict", true, "hash_mismatch");
  assert(injectedAtomicRace && await readFile(atomicRaceTarget, "utf8") === "concurrent-generation",
    "expected-hash atomic write failed to detect a source generation that changed before the final precondition check");

  // Exact edits must preserve semantic indentation, line endings and string contents.
  for (const [name, initial, oldText] of [
    ["python-indent.py", "if ready:\n    if nested:\n        work()\n", "if ready:\nif nested:\nwork()"],
    ["tab-indent.js", "\tfunction compute() {\n\t\treturn 1;\n\t}\n", "  function compute() {\n    return 1;\n  }"],
    ["string-literal.js", 'const msg = "hello  world";\n', 'const msg = "hello world";'],
    ["crlf-file.js", "const a = 1;\r\nconst b = 2;\r\n", "const a = 1;\nconst b = 2;"],
  ]) {
    const path = join(root, name);
    await writeFile(path, initial, { encoding: "utf8", mode: 0o600 });
    await expectAsyncThrow(() => warningService.editFile({ path: name, old_text: oldText, new_text: "changed" }), "old_text was not found", "not_found", true, "text_not_found");
    assert(await readFile(path, "utf8") === initial, "rejected edit changed the file");
  }
  const exactPath = join(root, "exact-indent.py");
  await writeFile(exactPath, "if ready:\n    work()\n", { encoding: "utf8", mode: 0o600 });
  const exact = await warningService.editFile({ path: "exact-indent.py", old_text: "if ready:\n    work()", new_text: "if ready:\n    work_again()" });
  assert(exact.matched === "exact" && await readFile(exactPath, "utf8") === "if ready:\n    work_again()\n", "exact edit lost semantic indentation");
  const patchEnvelope = ["*** Begin Patch", "*** Update File: exact-indent.py", "@@", "-  work_again()", "+  changed()", "*** End Patch"].join("\n");
  await expectAsyncThrow(() => warningService.applyPatch({ patch: patchEnvelope }), "patch context did not match", "conflict", true, "context_not_found");
  assert(await readFile(exactPath, "utf8") === "if ready:\n    work_again()\n", "rejected patch changed the file");

  // 3. SWE-agent window pagination guidance in readFile
  const largeFilePath = join(root, "large-file.txt");
  const largeContent = Array.from({ length: 350 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(largeFilePath, largeContent, { encoding: "utf8", mode: 0o600 });
  const readFull = await warningService.readFile({ path: "large-file.txt" });
  assert(readFull.total_lines === 350, "total_lines mismatch");
  assert(typeof readFull.pagination_guidance === "string" && readFull.pagination_guidance.includes("350 lines"), "large file omitted pagination_guidance");
  const readWindow = await warningService.readFile({ path: "large-file.txt", start_line: 1, end_line: 50 });
  assert(readWindow.start_line === 1 && readWindow.end_line === 50, "window boundaries mismatch");
  assert(typeof readWindow.pagination_guidance === "string" && readWindow.pagination_guidance.includes("start_line=51"), "window reading omitted subsequent pagination_guidance");

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
