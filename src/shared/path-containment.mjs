// @ts-check
import { isAbsolute, relative, sep } from "node:path";

/** @param {string} root @param {string} candidate @returns {boolean} */
export function isStrictChildPath(root, candidate) {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * @param {string} root
 * @param {string} candidate
 * @param {string} message
 * @param {(text: string) => Error} [createError]
 */
export function requireContainedPath(root, candidate, message, createError = (text) => new Error(text)) {
  if (!isStrictChildPath(root, candidate)) throw createError(message);
}
