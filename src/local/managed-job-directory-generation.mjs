import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesystemIdentity, filesystemTimeMs, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { withPinnedManagedJobDirectory } from "./managed-job-directory.mjs";
const RETIRED_JOB_DIRECTORY = /^retired_job_([A-Za-z0-9_-]{24})_d([0-9]+)_i([0-9]+)$/;
export function inspectManagedJobDirectoryGeneration(dir, label = "managed job directory") {
  const info = inspectDirectory(dir, label);
  return { identity: filesystemIdentity(info, label), mtimeMs: filesystemTimeMs(info.mtimeMs, `${label} modification time`) };
}
export function retiredManagedJobDirectories(jobRoot) {
  let entries; try { entries = readdirSync(jobRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const retired = [];
  for (const entry of entries) {
    if (!entry.name.startsWith("retired_job_")) continue;
    const match = RETIRED_JOB_DIRECTORY.exec(entry.name); const dir = join(jobRoot, entry.name);
    if (!match || !entry.isDirectory()) { retired.push({ name: entry.name, dir, identity: null, reclaimable: false, error_class: "integrity_error" }); continue; }
    try {
      const identity = filesystemIdentity(inspectDirectory(dir, "retired managed job directory"), "retired managed job directory");
      const reclaimable = identity.dev === BigInt(match[2]) && identity.ino === BigInt(match[3]);
      retired.push({ name: entry.name, dir, identity, reclaimable, error_class: reclaimable ? null : "integrity_error" });
    } catch (error) {
      if (error?.code !== "ENOENT") retired.push({ name: entry.name, dir, identity: null, reclaimable: false, error_class: "resource_unavailable" });
    }
  }
  return retired;
}
export function removeManagedJobDirectoryIfCurrent(dir, expectedIdentity, label = "managed job directory", options = {}) {
  const rename = typeof options.renameSync === "function" ? options.renameSync : renameSync;
  const result = withPinnedManagedJobDirectory(dir, label, options, true, (pinned) => {
    const pinnedIdentity = filesystemIdentity(pinned, label);
    if (!sameFilesystemIdentity(expectedIdentity, pinnedIdentity)) return false;
    const quarantine = join(dirname(dir), `retired_job_${randomBytes(18).toString("base64url")}_d${pinnedIdentity.dev}_i${pinnedIdentity.ino}`);
    try { rename(dir, quarantine); }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const moved = filesystemIdentity(inspectDirectory(quarantine, label), label);
    if (moved.dev !== pinnedIdentity.dev || moved.ino !== pinnedIdentity.ino) return false;
    rmSync(quarantine, { recursive: true, force: false });
    return true;
  });
  return result === true;
}
export function pruneRetiredManagedJobDirectories(jobRoot, logger = console) {
  for (const retired of retiredManagedJobDirectories(jobRoot)) {
    if (!retired.reclaimable) { logger.warn?.("retired managed-job directory generation is inconsistent; retaining it for inspection", { error_class: retired.error_class }); continue; }
    try {
      if (!removeManagedJobDirectoryIfCurrent(retired.dir, retired.identity, "retired managed job directory")) {
        logger.warn?.("retired managed-job directory changed during reclamation; retaining it for inspection", { error_class: "integrity_error" });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn?.("retired managed-job directory could not be reclaimed", { error_class: "resource_unavailable" });
    }
  }
}
function inspectDirectory(path, label) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
  return info;
}
