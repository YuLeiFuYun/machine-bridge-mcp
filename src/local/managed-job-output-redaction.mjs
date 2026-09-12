import { resolve } from "node:path";

export function managedJobResourcePathVariants(value, platform = process.platform) {
  const canonical = resolve(value);
  const variants = new Set(pathTextVariants(canonical));
  if (platform === "darwin" && canonical.startsWith("/private/")) {
    for (const variant of pathTextVariants(canonical.slice("/private".length))) variants.add(variant);
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

export function redactManagedJobOutput(buffer, context, runtimeDir, platform = process.platform, truncatedBytes = 0) {
  const safeBuffer = discardUnsafeTruncationTail(buffer, context, runtimeDir, platform, truncatedBytes);
  const redactedBytes = replaceBufferEntries(safeBuffer, byteRedactionEntries(context, runtimeDir));
  let text = new TextDecoder("utf-8").decode(redactedBytes);
  for (const entry of textRedactionEntries(context, runtimeDir, platform)) {
    text = replaceTextEntry(text, entry, platform);
  }
  return text;
}

function discardUnsafeTruncationTail(buffer, context, runtimeDir, platform, truncatedBytes) {
  if (!(Number(truncatedBytes) > 0) || !Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  const patterns = protectedBytePatterns(context, runtimeDir, platform);
  let end = buffer.length;
  while (end > 0) {
    const view = buffer.subarray(0, end);
    let longest = 0;
    for (const pattern of patterns) longest = Math.max(longest, partialSuffixLength(view, pattern));
    if (longest === 0) break;
    end -= longest;
  }
  return end === buffer.length ? buffer : buffer.subarray(0, end);
}

function protectedBytePatterns(context, runtimeDir, platform) {
  const values = [];
  for (const value of Object.values(context.bytes || {})) {
    if (Buffer.isBuffer(value) && value.length) values.push(value);
  }
  for (const path of Object.values(context.paths || {})) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  for (const paths of Object.values(context.sourcePaths || {})) {
    for (const path of paths || []) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  }
  for (const path of Object.values(context.temporaryPaths || {})) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  values.push(...managedJobResourcePathVariants(runtimeDir, platform).map((value) => Buffer.from(value)));
  for (const [, value] of literalRedactionEntries(context)) values.push(Buffer.from(value));
  const unique = new Map();
  for (const value of values) if (value.length) unique.set(value.toString("hex"), value);
  return [...unique.values()].sort((left, right) => right.length - left.length);
}

function literalRedactionEntries(context) {
  const entries = [];
  for (const [name, patterns] of Object.entries(context.redactions || {})) {
    if (!Array.isArray(patterns)) continue;
    for (const value of patterns) {
      if (typeof value === "string" && value.length > 0) entries.push([name, value]);
    }
  }
  return entries.sort((left, right) => right[1].length - left[1].length);
}

function pathRedactionEntries(context, runtimeDir) {
  const entries = [];
  const add = (value, replacement) => {
    for (const variant of pathTextVariants(value)) {
      if (variant) entries.push({ value: variant, replacement, caseInsensitive: true });
    }
  };
  for (const [name, path] of Object.entries(context.paths || {})) add(path, `<resource:${name}>`);
  for (const [name, paths] of Object.entries(context.sourcePaths || {})) {
    for (const path of paths || []) add(path, `<resource-source:${name}>`);
  }
  for (const [name, path] of Object.entries(context.temporaryPaths || {})) add(path, `<temp:${name}>`);
  add(runtimeDir, "<job-runtime>");
  return entries;
}

function textRedactionEntries(context, runtimeDir, platform) {
  if (platform !== "win32") return [];
  return pathRedactionEntries(context, runtimeDir)
    .map((entry) => ({ ...entry, caseInsensitive: true }))
    .sort((left, right) => right.value.length - left.value.length);
}

function byteRedactionEntries(context, runtimeDir) {
  const entries = [];
  for (const [name, value] of Object.entries(context.bytes || {})) {
    if (Buffer.isBuffer(value) && value.length > 0) {
      entries.push({ pattern: value, replacement: Buffer.from(`<redacted-resource:${name}>`) });
    }
  }
  for (const entry of pathRedactionEntries(context, runtimeDir)) {
    entries.push({ pattern: Buffer.from(entry.value), replacement: Buffer.from(entry.replacement) });
  }
  for (const [name, value] of literalRedactionEntries(context)) {
    entries.push({ pattern: Buffer.from(value), replacement: Buffer.from(`<redacted-resource:${name}>`) });
  }
  return entries.sort((left, right) => right.pattern.length - left.pattern.length);
}

function partialSuffixLength(buffer, pattern) {
  if (!pattern?.length || !buffer.length) return 0;
  if (pattern.length <= buffer.length && buffer.subarray(buffer.length - pattern.length).equals(pattern)) return 0;
  const minimumStart = Math.max(0, buffer.length - pattern.length + 1);
  let start = minimumStart;
  while (start < buffer.length) {
    const candidate = buffer.indexOf(pattern[0], start);
    if (candidate < 0) return 0;
    const length = buffer.length - candidate;
    if (length < pattern.length && buffer.subarray(candidate).equals(pattern.subarray(0, length))) return length;
    start = candidate + 1;
  }
  return 0;
}

function replaceBufferEntries(buffer, entries) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || entries.length === 0) return buffer;
  const parts = [];
  let cursor = 0;
  let literalStart = 0;
  while (cursor < buffer.length) {
    const entry = entries.find(({ pattern }) => cursor + pattern.length <= buffer.length
      && buffer.subarray(cursor, cursor + pattern.length).equals(pattern));
    if (!entry) { cursor += 1; continue; }
    if (cursor > literalStart) parts.push(buffer.subarray(literalStart, cursor));
    parts.push(entry.replacement);
    cursor += entry.pattern.length;
    literalStart = cursor;
  }
  if (literalStart === 0) return buffer;
  if (literalStart < buffer.length) parts.push(buffer.subarray(literalStart));
  return Buffer.concat(parts);
}

function pathTextVariants(value) {
  const path = String(value);
  return [...new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])];
}

function replaceTextEntry(text, entry, platform) {
  if (!entry.value) return text;
  if (platform === "win32" && entry.caseInsensitive) {
    return text.replace(new RegExp(escapeRegExp(entry.value), "gi"), entry.replacement);
  }
  return text.split(entry.value).join(entry.replacement);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
