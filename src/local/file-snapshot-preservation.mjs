import { unlinkSync } from "node:fs";
import { createExclusiveFileSync } from "./exclusive-file.mjs";
import { unlinkRegularFileIfIdentitySync } from "./secure-file.mjs";

export function preserveFileSnapshotSync(source, target, content, expectedIdentity, options = {}) {
  const label = String(options.label || "file snapshot source");
  const create = options.create || createExclusiveFileSync;
  const unlinkSource = options.unlinkSource || unlinkRegularFileIfIdentitySync;
  const unlinkBackup = options.unlinkBackup || unlinkSync;
  const created = create(target, content, { mode: Number.isInteger(options.mode) ? options.mode : 0o600 });
  let primaryError = null;
  try {
    if (!unlinkSource(source, expectedIdentity, label)) {
      primaryError = new Error(`${label} changed before snapshot preservation completed`);
    }
  } catch (error) { primaryError = error; }
  if (!primaryError) return created;
  try { unlinkBackup(target); } catch (cleanupError) {
    if (cleanupError?.code !== "ENOENT") {
      throw new AggregateError([primaryError, cleanupError], `${label} changed and snapshot cleanup was incomplete`);
    }
  }
  throw primaryError;
}
