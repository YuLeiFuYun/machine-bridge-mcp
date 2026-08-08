import { closeSync, constants as fsConstants, ftruncateSync, readSync, readdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { openRegularFileSync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { ensureOwnerOnlyDir, ownerOnlyFile } from "./secure-file.mjs";

export function atomicWriteJson(file, value, maxBytes) {
  ensureOwnerOnlyDir(dirname(file));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes`);
  replaceFileAtomicallySync(file, text, { mode: 0o600 });
  ownerOnlyFile(file);
}

export function readJson(file, maxBytes, label = "JSON") {
  let buffer;
  try {
    buffer = readBoundedRegularFileSync(file, maxBytes, "managed job state", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} is unavailable (${resourceErrorClass(error)})`);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try { return JSON.parse(text); } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function readRequiredJson(file, maxBytes, label) {
  const value = readJson(file, maxBytes, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is unavailable or invalid`);
  return value;
}

export function readBoundedFile(file, maxBytes) {
  return readBoundedRegularFileSync(file, maxBytes);
}

export function openPrivateAppendFile(file) {
  return openRegularFileSync(
    file,
    Number(fsConstants.O_WRONLY) | Number(fsConstants.O_CREAT) | Number(fsConstants.O_APPEND),
    { label: "runner diagnostic path", mode: 0o600, chmod: 0o600, rejectMultipleLinks: true },
  ).fd;
}

export function trimDiagnosticFile(file, maxBytes = 64 * 1024, keepBytes = 32 * 1024) {
  let fd;
  try {
    const opened = openRegularFileSync(file, fsConstants.O_RDWR, {
      label: "runner diagnostic path",
      chmod: 0o600,
      rejectMultipleLinks: true,
    });
    fd = opened.fd;
    if (opened.info.size <= maxBytes) return;
    const length = Math.min(keepBytes, opened.info.size);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, opened.info.size - length + offset);
      if (!count) break;
      offset += count;
    }
    let tail = buffer.subarray(0, offset);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline < tail.length - 1) tail = tail.subarray(newline + 1);
    ftruncateSync(fd, 0);
    if (tail.length) writeSync(fd, tail, 0, tail.length, 0);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {
        // Descriptor close is best effort after the trim result is already determined.
      }
    }
  }
}

export function resourceErrorClass(error) {
  const message = String(error?.message || error || "");
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/not found|ENOENT/i.test(message)) return "not_found";
  if (/symbolic link/i.test(message)) return "symbolic_link_denied";
  if (/multiple hard links/i.test(message)) return "insecure_links";
  if (/readable by group|permissions/i.test(message)) return "insecure_permissions";
  if (/exceeds/i.test(message)) return "size_limit";
  return "resource_unavailable";
}

export function safeReadDir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}
