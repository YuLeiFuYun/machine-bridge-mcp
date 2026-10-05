import { closeSync, constants as fsConstants, fstatSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import {
  openRegularFileSync,
  ownerOnlyFile,
  readBoundedRegularFileSync,
  retryTransientMultipleLinksSync,
} from "./secure-file.mjs";

export function readExclusivePublicationFileSync(target, maxBytes, label, options = {}) {
  return retryTransientMultipleLinksSync((residueIdentity) => {
    if (!residueIdentity && options.ownerPrivate === true) ownerOnlyFile(target);
    return readBoundedRegularFileSync(target, maxBytes, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
      allowedMultipleLinkIdentity: residueIdentity,
      afterOpen: options.ownerPrivate === true ? assertOwnerPrivateMode : undefined,
    });
  }, { verifyResidue: () => verifyExclusiveFilePublicationResidueSync(target) });
}

export function verifyExclusiveFilePublicationResidueSync(target) {
  let openedTarget;
  try {
    openedTarget = openRegularFileSync(target, fsConstants.O_RDONLY, {
      label: "exclusive publication target",
      verifyPathIdentity: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
  try {
    if (Number(openedTarget.info.nlink) !== 2) return null;
    const directory = dirname(target);
    const escapedBase = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stagingPattern = new RegExp(`^\\.${escapedBase}\\.[1-9][0-9]*\\.[a-f0-9]{16}\\.tmp$`);
    let matchingAliases = 0;
    for (const name of readdirSync(directory)) {
      if (!stagingPattern.test(name)) continue;
      let openedAlias;
      try {
        openedAlias = openRegularFileSync(join(directory, name), fsConstants.O_RDONLY, {
          label: "exclusive publication staging alias",
          verifyPathIdentity: true,
        });
      } catch (error) {
        if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") continue;
        return null;
      }
      try {
        if (Number(openedAlias.info.nlink) === 2
          && sameFilesystemIdentity(openedTarget.identity, openedAlias.identity)) matchingAliases += 1;
      } finally { closeSync(openedAlias.fd); }
      if (matchingAliases > 1) return null;
    }
    if (matchingAliases !== 1) return null;
    const settled = fstatSync(openedTarget.fd, { bigint: true });
    if (!settled.isFile() || settled.nlink !== 2n) return null;
    const settledIdentity = filesystemIdentity(settled, "exclusive publication settled target");
    return sameFilesystemIdentity(openedTarget.identity, settledIdentity) ? openedTarget.identity : null;
  } finally { closeSync(openedTarget.fd); }
}

function assertOwnerPrivateMode({ info }) {
  if (process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0) {
    throw new Error("exclusive publication file is not owner-private");
  }
}

export function snapshotFileIdentitySync(file) {
  const opened = openRegularFileSync(file, fsConstants.O_RDONLY, { verifyPathIdentity: true, rejectMultipleLinks: true });
  try { return opened.identity; } finally { closeSync(opened.fd); }
}

export async function publishFileLinkWithIdentity(source, target, publish, record, expectedSourceIdentity = null) {
  const opened = openRegularFileSync(source, fsConstants.O_RDONLY, { verifyPathIdentity: true, rejectMultipleLinks: true });
  try {
    if (expectedSourceIdentity && !sameFilesystemIdentity(expectedSourceIdentity, opened.identity)) {
      throw new Error("file snapshot changed before publication; preserved for inspection");
    }
    await publish(source, target);
    record.targetCreated = true;
    const info = fstatSync(opened.fd, { bigint: true });
    const identity = filesystemIdentity(info, "published file snapshot");
    const current = lstatSync(target, { bigint: true });
    if (!info.isFile() || info.nlink !== 2n || !current.isFile() || current.nlink !== 2n
        || !sameFilesystemIdentity(identity, filesystemIdentity(current))) {
      throw new Error("published target changed before confirmation; preserved for inspection");
    }
    record.targetIdentity = identity;
  } finally { closeSync(opened.fd); }
}

export async function removeLinkedFileSnapshot(file, expectedIdentity, remove) {
  let current;
  try { current = lstatSync(file, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!current.isFile() || current.nlink !== 2n || !sameFilesystemIdentity(expectedIdentity, filesystemIdentity(current))) {
    throw new Error("linked file snapshot changed before removal; preserved for inspection");
  }
  await remove(file, { force: true });
}

export async function restoreFileSnapshotNoReplace(backup, target, publish, remove, expectedIdentity) {
  if (!expectedIdentity) throw new Error("file snapshot identity is unavailable; preserved for inspection");
  const restored = {};
  await publishFileLinkWithIdentity(backup, target, publish, restored, expectedIdentity);
  await removeLinkedFileSnapshot(backup, restored.targetIdentity, remove);
}
