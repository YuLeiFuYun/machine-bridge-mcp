import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientReplaceError, replaceFileSync } from "../src/local/atomic-fs.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-atomic-replace-test-"));
try {
  const source = join(root, "source.json");
  const target = join(root, "target.json");
  await writeFile(source, "new", "utf8");
  await writeFile(target, "old", "utf8");
  let calls = 0;
  const result = replaceFileSync(source, target, {
    baseDelayMs: 1,
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
  assert(await readFile(target, "utf8") === "new", "replacement did not commit the new file");

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

  console.log("atomic file replacement retry test ok");
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
