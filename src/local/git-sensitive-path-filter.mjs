import { resolve, relative, isAbsolute, sep } from "node:path";
import { isSensitivePath } from "./operation-risk.mjs";

/**
 * Enumerate Git paths before returning any content to a delegated principal.
 * If enumeration is incomplete, fail closed rather than returning an unfiltered diff.
 */
export async function filterSensitiveGitPaths({
  target,
  root,
  context,
  commandArgs,
  pathspec,
  gitExecutable,
  runInternalProcess,
  environment,
}) {
  const args = [...commandArgs];
  if (pathspec) args.push("--", pathspec);
  const result = await runInternalProcess(
    gitExecutable, args, 30_000, true, 4 * 1024 * 1024, context, root, null, environment,
  );
  if (result.code !== 0 || Number(result.stdout_truncated_bytes || 0) > 0) {
    return {
      ok: false,
      code: result.code || 1,
      stderr: result.stderr || "cannot safely enumerate Git paths",
    };
  }
  const records = parseGitNameStatus(result.stdout);
  if (!records) return { ok: false, code: 1, stderr: "Git returned an incomplete path-status list" };
  const candidates = [...new Set(records.flatMap((record) => record.paths))]
    .filter((name) => isWithinPath(target, resolve(root, name)));
  const hidden = new Set();
  for (const record of records) {
    if (record.paths.some((name) => isSensitivePath(resolve(root, name)))) {
      for (const name of record.paths) hidden.add(name);
    }
  }
  const paths = candidates.filter((name) => !hidden.has(name));
  return { ok: true, paths, omittedSensitiveFiles: candidates.length - paths.length };
}

function parseGitNameStatus(output) {
  const tokens = String(output || "").split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const count = /^[RC]\d+$/.test(status) ? 2 : /^[A-Z]{1,2}$/.test(status) ? 1 : 0;
    if (!count || index + count > tokens.length) return null;
    const paths = tokens.slice(index, index + count);
    index += count;
    if (paths.some((name) => !name || name.includes("\0"))) return null;
    records.push({ status, paths });
  }
  return records;
}

function isWithinPath(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
