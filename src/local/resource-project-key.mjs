import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
export function resourceRequestForProject(request, cwd) {
  const result = { ...request };
  if (result.serialize_project !== true) return result;
  const project = normalizeResourceProjectIdentity(canonicalResourceProjectPath(cwd));
  return { ...result, contention_key: resourceProjectContentionKey(result.family, project) };
}

export function resourceProjectContentionKey(family, projectIdentity) {
  const material = `agent-resource-contention-v1\0${family || "unknown"}\0${String(projectIdentity || "")}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function resourceProjectIdentityHash(projectIdentity) {
  return createHash("sha256").update(String(projectIdentity || "")).digest("hex").slice(0, 24);
}

export function resourceProjectHash(cwd) {
  const identity = normalizeResourceProjectIdentity(canonicalResourceProjectPath(cwd));
  return resourceProjectIdentityHash(identity);
}

export function canonicalResourceProjectPath(cwd) {
  const target = resolve(cwd || process.cwd());
  const missing = [];
  let current = target;
  while (true) {
    try {
      const canonical = realpathSync.native ? realpathSync.native(current) : realpathSync(current);
      return missing.reduceRight((value, name) => resolve(value, name), canonical);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function normalizeResourceProjectIdentity(value, platform = process.platform) {
  let text = String(value || "");
  if (platform !== "win32") return text;
  text = text.replaceAll("/", "\\");
  const folded = text.toLowerCase();
  const extendedUnc = "\\\\?\\unc\\";
  const extended = "\\\\?\\";
  if (folded.startsWith(extendedUnc)) text = `\\\\${text.slice(extendedUnc.length)}`;
  else if (folded.startsWith(extended)) text = text.slice(extended.length);
  return text.toLowerCase();
}
