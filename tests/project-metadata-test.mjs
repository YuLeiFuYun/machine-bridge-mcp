import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRegularNonSymlink,
  readOptionalRegularUtf8,
  safeSingleLine,
  skippableMetadataError,
} from "../src/local/project-metadata.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-project-metadata-"));
try {
  const textFile = join(root, "metadata.txt");
  await writeFile(textFile, "hello\n", "utf8");
  assert.equal(await readOptionalRegularUtf8(textFile, 32), "hello\n");
  assert.equal(await readOptionalRegularUtf8(textFile, 2), null);
  assert.equal(await readOptionalRegularUtf8(join(root, "missing.txt"), 32), null);
  await assert.rejects(() => readOptionalRegularUtf8(textFile, -1), /non-negative safe integer/);
  await assert.rejects(() => readOptionalRegularUtf8(textFile, 1.5), /non-negative safe integer/);
  assert.equal(await isRegularNonSymlink(textFile), true);

  let metadataReadAttempted = false;
  let metadataHandleClosed = false;
  const identityStats = (ino) => ({
    dev: 7n, ino, size: 5n,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const precisionMismatch = await readOptionalRegularUtf8("virtual-metadata", 32, {
    openFile: async () => ({
      stat: async (options) => {
        assert.equal(options?.bigint, true);
        return identityStats(9007199254740993n);
      },
      read: async () => { metadataReadAttempted = true; return { bytesRead: 0 }; },
      close: async () => { metadataHandleClosed = true; },
    }),
    inspectPath: async (_path, options) => {
      assert.equal(options?.bigint, true);
      return identityStats(9007199254740992n);
    },
  });
  assert.equal(precisionMismatch, null);
  assert.equal(metadataReadAttempted, false, "project metadata read bytes after a lossless identity mismatch");
  assert.equal(metadataHandleClosed, true, "project metadata identity rejection leaked its descriptor");

  const invalidUtf8 = join(root, "invalid.bin");
  await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]));
  assert.equal(await readOptionalRegularUtf8(invalidUtf8, 32), null);

  const directory = join(root, "directory");
  await mkdir(directory);
  assert.equal(await readOptionalRegularUtf8(directory, 32), null);
  assert.equal(await isRegularNonSymlink(directory), false);

  if (process.platform !== "win32") {
    const linked = join(root, "linked.txt");
    await symlink(textFile, linked);
    assert.equal(await readOptionalRegularUtf8(linked, 32), null);
    assert.equal(await isRegularNonSymlink(linked), false);
  }

  assert.equal(safeSingleLine("  alpha\n beta\t gamma  ", 16), "alpha beta gamma");
  assert.equal(safeSingleLine(null, 16), "");
  assert.equal(skippableMetadataError({ code: "ENOENT" }), true);
  assert.equal(skippableMetadataError({ code: "EIO" }), false);
  console.log("project metadata helper test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
