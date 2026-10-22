import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isPublicationStagingArtifactName,
  repairExclusivePublicationLinksSync,
  sweepPublicationStagingArtifactsSync,
} from "./exclusive-publication-repair.mjs";
import { defaultResourceCoordinatorRoot } from "./resource-admission.mjs";
import { isIgnorableCoordinatorMetadata } from "./resource-staging-recovery.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const LEASE_FILE = /^lease_[a-f0-9]{32}\.json$/;
const WAITER_FILE = /^wait_[a-f0-9]{32}\.json$/;
const ROOT_STATE_FILE = /^(?:protocol|host-sample)\.json$/;
const MAX_STATE_BYTES = 64 * 1024;

/**
 * Report, and optionally repair, local state that can make every resource-coordinator
 * operation fail: a published lock, lease, waiter, or protocol marker that kept a second hard
 * link, malformed JSON, or an unexpected directory entry. Strict readers reject that state,
 * so without this check the failure looks like a generic `execution_failed` on every command.
 *
 * Metadata written by desktop indexers is reported but ignored by the coordinator itself;
 * only known metadata names are removed during an explicit repair.
 */
export function inspectResourceCoordinatorSync(root = null, options = {}) {
  const coordinatorRoot = root || defaultResourceCoordinatorRoot(options.env);
  const inspect = options.lstatSync || lstatSync;
  const read = options.readdirSync || readdirSync;
  const remove = options.unlink || unlinkSync;
  const repair = options.repair === true;
  const multiplyLinked = [];
  const repaired = [];
  const swept = [];
  const invalid = [];
  const unexpected = [];
  const metadata = [];
  const scan = coordinatorEntries(coordinatorRoot, { inspect, read });
  for (const file of scan.files) {
    const info = inspectIfPresent(file, inspect);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      unexpected.push(relative(coordinatorRoot, file));
      continue;
    }
    if (info.nlink > 1n) {
      multiplyLinked.push(relative(coordinatorRoot, file));
      if (!repair) continue;
      const outcome = repairExclusivePublicationLinksSync(file, {
        allowUnattributable: true,
        ...(options.repairOptions || {}),
      });
      if (outcome.repaired) {
        if (isValidCoordinatorState(file)) repaired.push(`${relative(coordinatorRoot, file)} (${outcome.kind})`);
        else invalid.push(relative(coordinatorRoot, file));
      }
      continue;
    }
    if (!isValidCoordinatorState(file)) invalid.push(relative(coordinatorRoot, file));
  }
  for (const file of scan.metadata) {
    if (repair) {
      try { remove(file); continue; } catch (error) { if (error?.code !== "ENOENT") unexpected.push(relative(coordinatorRoot, file)); continue; }
    }
    metadata.push(relative(coordinatorRoot, file));
  }
  for (const file of scan.unexpected) unexpected.push(relative(coordinatorRoot, file));
  if (repair) {
    for (const directory of [coordinatorRoot, join(coordinatorRoot, "waiters"), join(coordinatorRoot, "leases")]) {
      for (const name of sweepPublicationStagingArtifactsSync(directory, {
        lstatSync: inspect, readdirSync: read, now: options.now, minAgeMs: 60_000,
      })) swept.push(`${relative(coordinatorRoot, join(directory, name))}`);
    }
  }
  const unresolved = multiplyLinked.length - repaired.length;
  return {
    ok: unresolved === 0 && invalid.length === 0 && unexpected.length === 0,
    detail: coordinatorDetail({ multiplyLinked, repaired, swept, unresolved, repair, invalid, unexpected, metadata }),
    multiplyLinked,
    repaired,
    swept,
    invalid,
    unexpected,
    metadata,
  };
}

function isValidCoordinatorState(file) {
  try {
    const value = JSON.parse(readBoundedRegularFileSync(file, MAX_STATE_BYTES, "resource coordinator state", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).toString("utf8"));
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  } catch (error) {
    return error?.code === "ENOENT" || error?.cause?.code === "ENOENT";
  }
}

function coordinatorDetail({ multiplyLinked, repaired, swept, unresolved, repair, invalid, unexpected, metadata }) {
  if (!multiplyLinked.length && !swept.length && !repaired.length && !invalid.length && !unexpected.length) {
    return metadata.length ? `state files are single-linked; ignored desktop metadata in ${metadata.join(", ")}` : "state files are single-linked";
  }
  const parts = [];
  if (multiplyLinked.length) parts.push(`${multiplyLinked.length} multiply-linked state files`);
  if (repaired.length) parts.push(`${repaired.length} repaired`);
  if (swept.length) parts.push(`${swept.length} stale staging artifacts removed`);
  if (invalid.length) parts.push(`${invalid.length} invalid state files: ${invalid.join(", ")}`);
  if (unexpected.length) parts.push(`${unexpected.length} unexpected entries: ${unexpected.join(", ")}`);
  if (metadata.length) parts.push(`${metadata.length} ignored desktop metadata entries`);
  if (unresolved > 0) parts.push(repair ? `${unresolved} could not be repaired` : "run doctor --repair-resource-coordinator");
  return parts.join("; ");
}

function coordinatorEntries(root, io) {
  const files = [];
  const metadata = [];
  const unexpected = [];
  for (const directory of [root, join(root, "waiters"), join(root, "leases")]) {
    let names;
    try { names = io.read(directory); } catch { continue; }
    for (const name of names) {
      const file = join(directory, name);
      if (directory === root && (name === "leases" || name === "waiters")) {
        const info = inspectIfPresent(file, io.inspect || lstatSync);
        if (info?.isDirectory()) continue;
      }
      if (isIgnorableCoordinatorMetadata(name)) { metadata.push(file); continue; }
      if (isPublicationStagingArtifactName(name)) continue;
      const allowed = directory === root
        ? ROOT_STATE_FILE.test(name) || name.endsWith(".lock")
        : directory.endsWith("waiters") ? WAITER_FILE.test(name) : LEASE_FILE.test(name);
      if (allowed) files.push(file);
      else unexpected.push(file);
    }
  }
  return { files, metadata, unexpected };
}

function inspectIfPresent(target, inspect) {
  try {
    return inspect(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
