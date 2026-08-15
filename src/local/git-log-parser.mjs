// @ts-check

import { BridgeError } from "./errors.mjs";

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHORT_HASH = /^[0-9a-f]{4,64}$/;

/** @param {unknown} stdout @param {boolean} [includeAuthorEmail] */
export function parseStructuredGitLog(stdout, includeAuthorEmail = false) {
  /** @type {Array<{hash: string, short: string, authored_at: string, author_name: string, subject: string, author_email?: string}>} */
  const commits = [];
  const records = String(stdout || "").split("\x1e");
  for (let raw of records) {
    if (!raw) continue;
    if (raw === "\n" || raw === "\r\n") continue;
    if (raw.startsWith("\r\n")) raw = raw.slice(2);
    else if (raw.startsWith("\n")) raw = raw.slice(1);
    if (!raw) continue;
    const fields = raw.split("\x1f");
    if (fields.length !== 6) throw parseError();
    const [hash, short, authored_at, author_name, author_email, subject] = fields;
    if (!FULL_HASH.test(hash) || !SHORT_HASH.test(short) || !validIsoDate(authored_at)) throw parseError();
    /** @type {{hash: string, short: string, authored_at: string, author_name: string, subject: string, author_email?: string}} */
    const commit = { hash, short, authored_at, author_name, subject };
    if (includeAuthorEmail) commit.author_email = author_email;
    commits.push(commit);
  }
  return commits;
}

/** @param {string} value */
function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseError() {
  return new BridgeError("execution_failed", "Git log output failed structured framing validation", {
    details: { reason: "git_log_parse_failed" },
  });
}
