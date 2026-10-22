// @ts-check

/**
 * @param {unknown} value
 * @param {string} invalidMessage
 * @returns {string}
 */
export function canonicalTrustedOrigin(value, invalidMessage) {
  if (typeof value !== "string") throw new Error(invalidMessage);
  let url;
  try { url = new URL(value); } catch { throw new Error(invalidMessage); }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(invalidMessage);
  }
  return url.origin;
}
