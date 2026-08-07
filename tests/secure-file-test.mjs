import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPathIfPresentSync, openRegularFileSync, readBoundedRegularFileSync, readBoundedRegularFileWithInfoSync } from "../src/local/secure-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "../src/local/filesystem-identity.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-secure-file-test-"));
try {
  const file = join(root, "value.txt");
  await writeFile(file, "bounded-value", { mode: 0o600 });
  const value = readBoundedRegularFileSync(file, 64);
  if (value.toString("utf8") !== "bounded-value") throw new Error("bounded regular-file read returned incorrect content");
  const detailed = readBoundedRegularFileWithInfoSync(file, 64);
  if (!detailed.info.isFile() || detailed.buffer.toString("utf8") !== "bounded-value") throw new Error("bounded detailed read omitted file metadata or content");
  expectThrow(() => readBoundedRegularFileSync(file, 4), "file exceeds 4 bytes");
  if (!inspectPathIfPresentSync(file, "test file")?.isFile()) throw new Error("present-path inspection omitted the file");
  if (inspectPathIfPresentSync(join(root, "missing"), "missing test file") !== null) throw new Error("missing-path inspection did not return null");
  expectThrow(() => inspectPathIfPresentSync(file, "test file", {
    lstatSync() { throw Object.assign(new Error("synthetic storage failure"), { code: "EIO" }); },
  }), "could not be inspected");

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
  const highIdentityA = filesystemIdentity({ dev: 7n, ino: 9007199254740992n }, "high identity A");
  const highIdentityB = filesystemIdentity({ dev: 7n, ino: 9007199254740993n }, "high identity B");
  if (sameFilesystemIdentity(highIdentityA, highIdentityB)) throw new Error("lossless filesystem identity collapsed adjacent >2^53 inode values");
  expectThrow(() => filesystemIdentity({ dev: 7, ino: Number(9007199254740993n) }, "unsafe injected identity"), "cannot be represented losslessly");
  expectThrow(() => openRegularFileSync(file, 0, {
    verifyPathIdentity: true,
    fstatSync() { return syntheticStat(7n, 9007199254740992n); },
    lstatSync() { return syntheticStat(7n, 9007199254740993n); },
  }), "identity changed while opening");

  const safeNumberIdentity = filesystemIdentity({ dev: 9, ino: 11 });
  if (safeNumberIdentity.dev !== 9n || safeNumberIdentity.ino !== 11n
    || !sameFilesystemIdentity(safeNumberIdentity, { dev: 9n, ino: 11n })
    || sameFilesystemIdentity(null, safeNumberIdentity)
    || sameFilesystemIdentity(safeNumberIdentity, { dev: 10n, ino: 11n })) {
    throw new Error("filesystem identity safe-number/null/difference branches drifted");
  }
  expectThrow(() => filesystemIdentity(null), "identity is unavailable");
  expectThrow(() => exactFilesystemInteger(-1n, "negative bigint"), "is invalid");
  expectThrow(() => exactFilesystemInteger(-1, "negative number"), "cannot be represented losslessly");
  expectThrow(() => exactFilesystemInteger("7", "string identity"), "cannot be represented losslessly");
  if (exactFilesystemInteger(12n, "bigint identity") !== 12n || exactFilesystemInteger(13, "number identity") !== 13n) {
    throw new Error("exact filesystem integer conversion changed");
  }
  if (filesystemTimeMs(123n, "bigint time") !== 123 || filesystemTimeMs(456.5, "number time") !== 456.5) {
    throw new Error("filesystem time conversion changed");
  }
  expectThrow(() => filesystemTimeMs(-1n, "negative bigint time"), "cannot be represented safely");
  expectThrow(() => filesystemTimeMs(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "oversized bigint time"), "cannot be represented safely");
  expectThrow(() => filesystemTimeMs(-1, "negative number time"), "is invalid");
  expectThrow(() => filesystemTimeMs(Number.NaN, "nan time"), "is invalid");
  expectThrow(() => filesystemTimeMs("1", "string time"), "is invalid");
  console.log("secure bounded-file test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function syntheticStat(dev, ino) {
  return {
    dev, ino, size: 13, nlink: 1, mode: 0o100600,
    isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false,
  };
}

function expectThrow(callback, message) {
  try { callback(); } catch (error) {
    if (!message || String(error?.message || error).includes(message)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${message}`);
}
