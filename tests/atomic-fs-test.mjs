import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientReplaceError, replaceFileSync } from "../src/local/atomic-fs.mjs";
import { commitPatchTransaction, sha256 } from "../src/local/workspace-file-service.mjs";

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
  await expectAsyncThrow(() => commitPatchTransaction([{
    kind: "update",
    source: rollbackTarget,
    target: rollbackTarget,
    content: "new",
    originalHash: sha256("old"),
    mode: 0o600,
  }], {
    async rename(from, to) {
      if (from.includes(".mbm-patch-")) throw new Error("simulated commit failure");
      if (from.includes(".mbm-backup-")) throw new Error("simulated rollback failure");
      return rename(from, to);
    },
  }), "recovery was incomplete", "internal_error", false);

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

  console.log("atomic file replacement and patch recovery test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
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
