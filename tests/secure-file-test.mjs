import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodRegularFileIfIdentitySync, inspectPathIfPresentSync, openRegularFileSync, readBoundedRegularFileSync, readBoundedRegularFileWithInfoSync, retryTransientMultipleLinksSync, unlinkRegularFileIfIdentitySync } from "../src/local/secure-file.mjs";
import { exactFilesystemInteger, filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "../src/local/filesystem-identity.mjs";
import { removeOwnedJsonFileSync } from "../src/local/exclusive-file.mjs";
import { preserveFileSnapshotSync } from "../src/local/file-snapshot-preservation.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-secure-file-test-"));
try {
  const file = join(root, "value.txt");
  await writeFile(file, "bounded-value", { mode: 0o600 });
  const value = readBoundedRegularFileSync(file, 64);
  if (value.toString("utf8") !== "bounded-value") throw new Error("bounded regular-file read returned incorrect content");
  const detailed = readBoundedRegularFileWithInfoSync(file, 64);
  if (!detailed.info.isFile() || detailed.buffer.toString("utf8") !== "bounded-value"
      || typeof detailed.identityInfo?.dev !== "bigint" || typeof detailed.identityInfo?.ino !== "bigint") {
    throw new Error("bounded detailed read omitted file metadata, exact identity info, or content");
  }
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
    const owned = join(root, "owned.json");
    const ownedAlias = join(root, "owned-alias.json");
    await writeFile(owned, `${JSON.stringify({ token: "owned-token", purpose: "test" })}\n`, { mode: 0o600 });
    await link(owned, ownedAlias);
    expectThrow(() => removeOwnedJsonFileSync(owned, { token: "owned-token", purpose: "test" }), "multiple hard links");
    if ((await readFile(owned, "utf8")).length === 0 || (await readFile(ownedAlias, "utf8")).length === 0) {
      throw new Error("owned JSON removal modified a multiply-linked lock");
    }
  }
  expectThrow(() => readBoundedRegularFileSync(file, -1), "maximum file size");
  if (process.platform !== "win32") {
    const chmodSource = join(root, "identity-chmod.txt");
    await writeFile(chmodSource, "owned-before-chmod", { mode: 0o600 });
    const chmodSnapshot = readBoundedRegularFileWithInfoSync(chmodSource, 1024, "identity chmod test", { verifyPathIdentity: true });
    await rm(chmodSource, { force: true });
    await writeFile(chmodSource, "replacement-before-chmod", { mode: 0o600 });
    expectThrow(() => chmodRegularFileIfIdentitySync(chmodSource, chmodSnapshot.identity, 0o644, "identity chmod test"), "changed before permission update");
    const replacementMode = (await stat(chmodSource)).mode & 0o777;
    if (replacementMode !== 0o600 || await readFile(chmodSource, "utf8") !== "replacement-before-chmod") {
      throw new Error("identity-checked chmod modified a replacement path");
    }
  }

  if (process.platform !== "win32") {
    const unlinkSource = join(root, "identity-unlink.txt");
    const unlinkAlias = join(root, "identity-unlink.alias");
    await writeFile(unlinkSource, "identity-unlink", { mode: 0o600 });
    const unlinkSnapshot = readBoundedRegularFileWithInfoSync(unlinkSource, 1024, "identity unlink test", { verifyPathIdentity: true });
    await link(unlinkSource, unlinkAlias);
    if (unlinkRegularFileIfIdentitySync(unlinkSource, unlinkSnapshot.identity, "identity unlink test") !== false
        || await readFile(unlinkSource, "utf8") !== "identity-unlink" || await readFile(unlinkAlias, "utf8") !== "identity-unlink") {
      throw new Error("identity-checked unlink accepted a newly multiply-linked ownership file");
    }
  }

  const preserveSource = join(root, "preserve-source.json");
  const preserveTarget = join(root, "preserve-backup.json");
  await writeFile(preserveSource, "original-corrupt-bytes", { mode: 0o600 });
  const preserveSnapshot = readBoundedRegularFileWithInfoSync(preserveSource, 1024, "preserve test", { verifyPathIdentity: true });
  await rm(preserveSource, { force: true });
  await writeFile(preserveSource, "replacement-must-survive", { mode: 0o600 });
  expectThrow(() => preserveFileSnapshotSync(preserveSource, preserveTarget, preserveSnapshot.buffer, preserveSnapshot.identity, { label: "preserve test" }), "changed before snapshot preservation");
  if (await readFile(preserveSource, "utf8") !== "replacement-must-survive") {
    throw new Error("identity-mismatched snapshot preservation removed the replacement file");
  }
  try {
    await readFile(preserveTarget);
    throw new Error("identity-mismatched snapshot preservation leaked a misleading backup");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }

  const virtualCreated = { created: true, path: "virtual-backup", warnings: [] };
  const virtualCreate = () => virtualCreated;
  if (preserveFileSnapshotSync("source", "backup", Buffer.from("x"), { dev: 1n, ino: 2n }, { create: virtualCreate, unlinkSource: () => true, unlinkBackup: () => { throw new Error("cleanup must not run"); } }) !== virtualCreated) {
    throw new Error("snapshot preservation changed its successful creation result");
  }
  expectThrow(() => preserveFileSnapshotSync("source", "backup", Buffer.from("x"), { dev: 1n, ino: 2n }, {
    create: virtualCreate, unlinkSource: () => false, unlinkBackup: () => { throw Object.assign(new Error("already absent"), { code: "ENOENT" }); },
  }), "changed before snapshot preservation");
  const syntheticPrimary = new Error("synthetic source unlink failure");
  expectThrow(() => preserveFileSnapshotSync("source", "backup", Buffer.from("x"), { dev: 1n, ino: 2n }, {
    create: virtualCreate, unlinkSource: () => { throw syntheticPrimary; }, unlinkBackup: () => {},
  }), "synthetic source unlink failure");
  const syntheticCleanup = new Error("synthetic backup cleanup failure");
  let aggregate = null;
  try {
    preserveFileSnapshotSync("source", "backup", Buffer.from("x"), { dev: 1n, ino: 2n }, {
      create: virtualCreate, unlinkSource: () => { throw syntheticPrimary; }, unlinkBackup: () => { throw syntheticCleanup; },
    });
  } catch (error) { aggregate = error; }
  if (!(aggregate instanceof AggregateError) || aggregate.errors?.[0] !== syntheticPrimary || aggregate.errors?.[1] !== syntheticCleanup) {
    throw new Error("snapshot preservation lost primary-before-cleanup AggregateError causality");
  }

  let transientLinkAttempts = 0;
  const transientLinkResult = retryTransientMultipleLinksSync(() => {
    transientLinkAttempts += 1;
    if (transientLinkAttempts < 4) throw Object.assign(new Error("synthetic publication link"), { code: "MBM_MULTIPLE_HARD_LINKS" });
    return "settled";
  });
  if (transientLinkResult !== "settled" || transientLinkAttempts !== 4) {
    throw new Error("exclusive-publication multiple-link retry did not settle within its fixed budget");
  }
  let persistentLinkAttempts = 0;
  let persistentLinkError = null;
  try {
    retryTransientMultipleLinksSync(() => {
      persistentLinkAttempts += 1;
      throw Object.assign(new Error("persistent multiple hard links"), { code: "MBM_MULTIPLE_HARD_LINKS" });
    });
  } catch (error) { persistentLinkError = error; }
  if (persistentLinkAttempts !== 4 || persistentLinkError?.code !== "MBM_MULTIPLE_HARD_LINKS") {
    throw new Error("exclusive-publication multiple-link retry became unbounded or failed open");
  }

  const reusedGenerationA = filesystemIdentity({ dev: 5n, ino: 8n, ctimeNs: 100n }, "generation A");
  const reusedGenerationB = filesystemIdentity({ dev: 5n, ino: 8n, ctimeNs: 101n }, "generation B");
  if (sameFilesystemIdentity(reusedGenerationA, reusedGenerationB)) throw new Error("filesystem identity accepted same-inode generation reuse");
  if (sameFilesystemIdentity(reusedGenerationA, { dev: 5n, ino: 8n })) throw new Error("filesystem identity dropped a known generation during comparison");

  const highIdentityA = filesystemIdentity({ dev: 7n, ino: 9007199254740992n }, "high identity A");
  const highIdentityB = filesystemIdentity({ dev: 7n, ino: 9007199254740993n }, "high identity B");
  if (sameFilesystemIdentity(highIdentityA, highIdentityB)) throw new Error("lossless filesystem identity collapsed adjacent >2^53 inode values");
  expectThrow(() => filesystemIdentity({ dev: 7, ino: Number(9007199254740993n) }, "unsafe injected identity"), "cannot be represented losslessly");
  let identityChanged = null;
  try {
    openRegularFileSync(file, 0, {
      verifyPathIdentity: true,
      fstatSync() { return syntheticStat(7n, 9007199254740992n); },
      lstatSync() { return syntheticStat(7n, 9007199254740993n); },
    });
  } catch (error) { identityChanged = error; }
  if (identityChanged?.code !== "MBM_IDENTITY_CHANGED" || !String(identityChanged.message).includes("identity changed while opening")) {
    throw new Error("secure file identity change lost its stable retry classification");
  }

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
