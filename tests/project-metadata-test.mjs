import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPlainRecord,
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
  assert.equal(await isRegularNonSymlink(textFile), true);

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
  assert.equal(isPlainRecord({}), true);
  assert.equal(isPlainRecord([]), false);
  assert.equal(isPlainRecord(null), false);
  assert.equal(skippableMetadataError({ code: "ENOENT" }), true);
  assert.equal(skippableMetadataError({ code: "EIO" }), false);
  console.log("project metadata helper test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
