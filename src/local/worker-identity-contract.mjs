// @ts-check
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OAUTH_TOKEN_VERSION = /^token_version_[A-Za-z0-9_-]{43}$/;

/** @param {unknown} value @returns {boolean} */
export function isWorkerName(value) {
  return typeof value === "string" && WORKER_NAME.test(value);
}

/** @param {unknown} value @returns {boolean} */
export function isOAuthTokenVersion(value) {
  return typeof value === "string" && OAUTH_TOKEN_VERSION.test(value);
}

/** @param {unknown} value @returns {boolean} */
export function isPreviousWorkerNames(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 32 && value.every(isWorkerName));
}
