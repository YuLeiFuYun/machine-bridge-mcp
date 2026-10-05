import { mkdir, mkdtemp, opendir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  assert(await assertGitMetadataTreesSafe([dir], { maximumEntries: 2 }) === 2, "unchanged metadata directory lost bounded traversal");
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

  const empty = join(root, "cancelled-open-empty");
  await mkdir(empty);
  const openingCancellation = new AbortController();
  const openingReason = new Error("synthetic cancellation during metadata open");
  let cancelledHandleClosed = false;
  const openingFailure = await rejected(() => assertGitMetadataTreesSafe([empty], {
    signal: openingCancellation.signal,
    opendir: async (target) => {
      const directory = await opendir(target);
      openingCancellation.abort(openingReason);
      return {
        [Symbol.asyncIterator]: () => directory[Symbol.asyncIterator](),
        close: () => { cancelledHandleClosed = true; return directory.close(); },
      };
    },
  }));
  assert(openingFailure === openingReason && cancelledHandleClosed,
    "empty metadata open lost cancellation or left its directory handle unsettled");

  if (process.platform !== "win32") {
    for (const phase of ["open", "iterate"]) {
      for (const replacement of ["symlink", "directory"]) {
        const fixture = join(await realpath(root), phase + "-" + replacement + "-replacement");
        const metadata = join(fixture, "metadata"), outside = join(fixture, "outside");
        await mkdir(metadata, { recursive: true });
        await mkdir(outside);
        await writeFile(join(metadata, "HEAD"), "original\n");
        await writeFile(join(outside, "HEAD"), "owned other tree\n");
        let changed = false, enumerated = 0, closeAttempted = false;
        const replaceDirectory = async () => {
          if (changed) return;
          await rename(metadata, metadata + "-original");
          if (replacement === "symlink") await symlink(outside, metadata, "dir");
          else {
            await mkdir(metadata);
            await writeFile(join(metadata, "HEAD"), "replacement\n");
          }
          changed = true;
        };
        const failure = await rejected(() => assertGitMetadataTreesSafe([metadata], {
          opendir: async (target) => {
            if (phase === "open") await replaceDirectory();
            const directory = await opendir(target);
            return {
              async *[Symbol.asyncIterator]() {
                for await (const entry of directory) {
                  if (phase === "iterate") await replaceDirectory();
                  enumerated += 1;
                  yield entry;
                }
              },
              close: () => { closeAttempted = true; return directory.close(); },
            };
          },
        }));
        assert(changed && closeAttempted && failure?.code === "path_boundary"
          && failure?.details?.reason === "git_metadata_boundary",
        "metadata directory replacement during " + phase + " lost generation-bound rejection or cleanup");
        if (phase === "open") assert(enumerated === 0, "replaced metadata directory was enumerated after open");
      }
    }
    for (const ancestorReplacement of [false, true]) {
      const fixture = join(await realpath(root), ancestorReplacement ? "ancestor-race" : "leaf-race");
      const metadata = join(fixture, "metadata");
      const queued = join(metadata, "objects");
      const outside = join(fixture, "outside");
      await mkdir(ancestorReplacement ? join(queued, "fanout") : queued, { recursive: true });
      await mkdir(ancestorReplacement ? join(outside, "fanout") : outside, { recursive: true });
      await writeFile(join(outside, ancestorReplacement ? "fanout/synthetic" : "synthetic"), "synthetic\n");
      const swapAfter = ancestorReplacement ? queued : metadata;
      const vulnerablePath = ancestorReplacement ? join(queued, "fanout") : queued;
      let swapped = false;
      let outsideOpened = false;
      const failure = await rejected(() => assertGitMetadataTreesSafe([metadata], {
        opendir: async (target) => {
          if (swapped && target === vulnerablePath) outsideOpened = true;
          const directory = await opendir(target);
          return {
            async *[Symbol.asyncIterator]() {
              for await (const entry of directory) yield entry;
              if (target === swapAfter) {
                await rename(queued, queued + "-original");
                await symlink(outside, queued, "dir");
                swapped = true;
              }
            },
            close: () => directory.close(),
          };
        },
      }));
      assert(swapped && !outsideOpened && failure?.code === "path_boundary",
        "queued metadata directory or ancestor replacement escaped the canonical boundary");
    }
  }

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
