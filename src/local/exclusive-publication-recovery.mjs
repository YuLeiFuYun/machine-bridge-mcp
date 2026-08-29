import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";

export function recoverExclusiveFilePublicationSync(target) {
  let targetFd;
  try { targetFd = openSync(target, Number(fsConstants.O_RDONLY) | Number(fsConstants.O_NOFOLLOW || 0)); }
  catch { return false; }
  try {
    const openedTarget = fstatSync(targetFd, { bigint: true });
    if (!openedTarget.isFile() || openedTarget.nlink !== 2n) return false;
    const targetIdentity = filesystemIdentity(openedTarget, "exclusive publication open target");
    const targetInfo = lstatSync(target, { bigint: true });
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 2n
      || !sameFilesystemIdentity(targetIdentity, filesystemIdentity(targetInfo, "exclusive publication target"))) return false;
    const aliases = publicationAliases(target, targetIdentity);
    if (aliases.length !== 1) return false;
    const alias = aliases[0];
    const currentAlias = lstatSync(alias, { bigint: true });
    if (currentAlias.isSymbolicLink() || !currentAlias.isFile() || currentAlias.nlink !== 2n
      || !sameFilesystemIdentity(targetIdentity, filesystemIdentity(currentAlias, "exclusive publication staging alias"))) return false;
    try { unlinkSync(alias); } catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    const held = fstatSync(targetFd, { bigint: true });
    const settled = lstatSync(target, { bigint: true });
    const heldIdentity = filesystemIdentity(held, "exclusive publication held target");
    const settledIdentity = filesystemIdentity(settled, "exclusive publication settled target");
    return held.isFile() && held.nlink === 1n && !settled.isSymbolicLink() && settled.isFile() && settled.nlink === 1n
      && heldIdentity.dev === settledIdentity.dev && heldIdentity.ino === settledIdentity.ino;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally { closeSync(targetFd); }
}

function publicationAliases(target, targetIdentity) {
  const directory = dirname(target);
  const escapedBase = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stagingPattern = new RegExp(`^\\.${escapedBase}\\.[1-9][0-9]*\\.[a-f0-9]{16}\\.tmp$`);
  const aliases = [];
  for (const name of readdirSync(directory)) {
    if (!stagingPattern.test(name)) continue;
    const alias = join(directory, name);
    let info;
    try { info = lstatSync(alias, { bigint: true }); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (!info.isSymbolicLink() && info.isFile() && info.nlink === 2n
      && sameFilesystemIdentity(targetIdentity, filesystemIdentity(info, "exclusive publication staging alias"))) aliases.push(alias);
  }
  return aliases;
}
