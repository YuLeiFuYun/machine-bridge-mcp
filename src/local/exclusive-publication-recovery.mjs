import { closeSync, constants as fsConstants, fstatSync, readdirSync } from "node:fs";
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
