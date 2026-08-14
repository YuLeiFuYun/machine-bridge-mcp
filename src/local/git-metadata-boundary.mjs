import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BridgeError } from "./errors.mjs";
import { pathEntryIfExists } from "./path-inspection.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_ALTERNATES_BYTES = 64 * 1024;
const MAX_ALTERNATE_STORES = 64;

export async function resolveGitMetadataBoundary({ gitDir, commonDir, resolveExistingPath, context = {} }) {
  const objectDir = await requireDirectory(join(commonDir, "objects"), resolveExistingPath, context, "Git object directory");
  const alternateObjectDirs = await resolveAlternateObjectStores(objectDir, resolveExistingPath, context);
  const metadataPaths = [];
  for (const candidate of [
    join(gitDir, "HEAD"),
    join(gitDir, "index"),
    join(gitDir, "refs"),
    join(gitDir, "logs"),
    join(gitDir, "reftable"),
    join(commonDir, "packed-refs"),
    join(commonDir, "shallow"),
    join(commonDir, "refs"),
    join(commonDir, "logs"),
    join(commonDir, "reftable"),
    join(commonDir, "info"),
    join(objectDir, "pack"),
    join(objectDir, "info"),
  ]) {
    const entry = await pathEntryIfExists(candidate);
    if (!entry) continue;
    if (entry.isSymbolicLink()) throw boundaryError("Git metadata path must not be a symbolic link");
    metadataPaths.push(await resolveExistingPath(candidate, context));
  }
  return Object.freeze({ objectDir, alternateObjectDirs: Object.freeze(alternateObjectDirs), metadataPaths: Object.freeze(metadataPaths) });
}

async function resolveAlternateObjectStores(primaryObjectDir, resolveExistingPath, context) {
  const queue = [primaryObjectDir];
  const seen = new Set([primaryObjectDir]);
  const alternates = [];
  while (queue.length) {
    const objectDir = queue.shift();
    const marker = join(objectDir, "info", "alternates");
    const entry = await pathEntryIfExists(marker);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || Number(entry.nlink) !== 1) throw boundaryError("Git alternates metadata must be a single-link regular file");
    const bytes = readBoundedRegularFileSync(marker, MAX_ALTERNATES_BYTES, "Git alternates metadata", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
    const text = bytes.toString("utf8");
    if (text.includes("\0") || text.includes("\r")) throw boundaryError("Git alternates metadata is invalid");
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) throw boundaryError("Git alternate object path is invalid");
      const candidate = isAbsolute(raw) ? raw : resolve(objectDir, raw);
      const canonical = await requireDirectory(candidate, resolveExistingPath, context, "Git alternate object directory");
      if (seen.has(canonical)) continue;
      if (seen.size >= MAX_ALTERNATE_STORES) throw new BridgeError("limit_exceeded", `Git alternate object store count exceeds ${MAX_ALTERNATE_STORES}`);
      seen.add(canonical);
      alternates.push(canonical);
      queue.push(canonical);
    }
  }
  return alternates;
}

async function requireDirectory(path, resolveExistingPath, context, label) {
  const canonical = await resolveExistingPath(path, context);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw boundaryError(`${label} is unavailable`);
  return canonical;
}

function boundaryError(message) {
  return new BridgeError("path_boundary", message, { details: { reason: "git_metadata_boundary" } });
}
