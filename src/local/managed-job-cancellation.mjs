import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { inspectPathIfPresentSync, readBoundedRegularFileSync } from "./secure-file.mjs";

const MAX_CANCELLATION_BYTES = 128;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function writeManagedJobCancellation(file, now = new Date(), options = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now || "");
  if (!validTimestamp(timestamp)) throw new Error("managed job cancellation timestamp is invalid");
  const replace = options.replaceFile || replaceFileAtomicallySync;
  replace(file, `${timestamp}\n`, { mode: 0o600 });
}

export function managedJobCancellationRequested(file, options = {}) {
  const inspect = options.inspectPath || ((target) => inspectPathIfPresentSync(
    target,
    "managed job cancellation marker",
    options.inspectOptions || {},
  ));
  const info = inspect(file);
  if (!info) return false;
  if (info.isSymbolicLink?.() || !info.isFile?.()) {
    throw new Error("managed job cancellation marker must be a regular file and not a symbolic link");
  }
  if (Number(info.nlink) > 1) throw new Error("managed job cancellation marker must not have multiple hard links");
  const read = options.readFile || ((target) => readBoundedRegularFileSync(
    target,
    MAX_CANCELLATION_BYTES,
    "managed job cancellation marker",
    { verifyPathIdentity: true, rejectMultipleLinks: true },
  ));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read(file));
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1 || !validTimestamp(text.slice(0, -1))) {
    throw new Error("managed job cancellation marker is invalid");
  }
  return true;
}

function validTimestamp(value) {
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(Date.parse(value)).toISOString() === value;
}
