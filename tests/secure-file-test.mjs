import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedRegularFileSync, readBoundedRegularFileWithInfoSync } from "../src/local/secure-file.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-secure-file-test-"));
try {
  const file = join(root, "value.txt");
  await writeFile(file, "bounded-value", { mode: 0o600 });
  const value = readBoundedRegularFileSync(file, 64);
  if (value.toString("utf8") !== "bounded-value") throw new Error("bounded regular-file read returned incorrect content");
  const detailed = readBoundedRegularFileWithInfoSync(file, 64);
  if (!detailed.info.isFile() || detailed.buffer.toString("utf8") !== "bounded-value") throw new Error("bounded detailed read omitted file metadata or content");
  expectThrow(() => readBoundedRegularFileSync(file, 4), "file exceeds 4 bytes");

  if (process.platform !== "win32") {
    const moved = join(root, "opened-value.txt");
    const stable = readBoundedRegularFileSync(file, 64, "replacement test", {
      afterOpen() {
        renameSync(file, moved);
        writeFileSync(file, "replacement-value", { mode: 0o600 });
      },
    });
    if (stable.toString("utf8") !== "bounded-value") throw new Error("descriptor read followed a replacement path instead of the opened file");
    await rm(file, { force: true });
    renameSync(moved, file);
  }

  const directory = join(root, "directory");
  await mkdir(directory);
  expectThrow(() => readBoundedRegularFileSync(directory, 64), "not a regular file");

  if (process.platform !== "win32") {
    const symbolicLink = join(root, "value-link");
    await symlink(file, symbolicLink);
    expectThrow(() => readBoundedRegularFileSync(symbolicLink, 64), "");
    const hardLink = join(root, "value-hard-link");
    await link(file, hardLink);
    expectThrow(() => readBoundedRegularFileSync(file, 64, "owner state", { rejectMultipleLinks: true }), "multiple hard links");
    if (readBoundedRegularFileSync(file, 64).toString("utf8") !== "bounded-value") throw new Error("ordinary bounded read rejected a hard link without the secure-owner option");
  }
  expectThrow(() => readBoundedRegularFileSync(file, -1), "maximum file size");
  console.log("secure bounded-file test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectThrow(callback, message) {
  try { callback(); } catch (error) {
    if (!message || String(error?.message || error).includes(message)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${message}`);
}
