const OPERATIONAL_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EIO",
  "ENOSPC",
  "EDQUOT",
  "ENOMEM",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "ENOBUFS",
  "EINTR",
  "ESTALE",
  "EBUSY",
  "ETIMEDOUT",
]);

export class PrivateToolchainIntegrityError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PrivateToolchainIntegrityError";
    this.code = "private_toolchain_integrity_invalid";
  }
}

export function privateToolchainIntegrityError(message, cause = undefined) {
  return new PrivateToolchainIntegrityError(message, cause === undefined ? {} : { cause });
}

export function isPrivateToolchainIntegrityError(error) {
  return error instanceof PrivateToolchainIntegrityError
    || error?.code === "private_toolchain_integrity_invalid";
}

export function throwOperationalOrIntegrity(error, message) {
  if (error instanceof TypeError || error instanceof RangeError || operationalErrorCode(error)) throw error;
  throw privateToolchainIntegrityError(message, error);
}

export function operationalErrorCode(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const code = String(current.code || "");
    if (OPERATIONAL_ERROR_CODES.has(code)) return code;
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return "";
}
