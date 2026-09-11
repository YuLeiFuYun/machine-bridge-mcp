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
  let redactedBytes = safeBuffer;
  for (const [name, value] of Object.entries(context.bytes || {})) {
    redactedBytes = replaceBuffer(redactedBytes, value, Buffer.from(`<redacted-resource:${name}>`));
  }
  let text = new TextDecoder("utf-8").decode(redactedBytes);
  for (const [name, path] of Object.entries(context.paths)) {
    text = replacePathText(text, path, `<resource:${name}>`, platform);
  }
  for (const [name, paths] of Object.entries(context.sourcePaths || {})) {
    for (const path of paths) text = replacePathText(text, path, `<resource-source:${name}>`, platform);
  }
  for (const [name, path] of Object.entries(context.temporaryPaths)) {
    text = replacePathText(text, path, `<temp:${name}>`, platform);
  }
  text = replacePathText(text, runtimeDir, "<job-runtime>", platform);
  for (const [name, patterns] of Object.entries(context.redactions)) {
    for (const value of patterns) text = text.split(value).join(`<redacted-resource:${name}>`);
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
  for (const patterns of Object.values(context.redactions || {})) {
    for (const value of patterns || []) if (value) values.push(Buffer.from(value));
  }
  const unique = new Map();
  for (const value of values) if (value.length) unique.set(value.toString("hex"), value);
  return [...unique.values()].sort((left, right) => right.length - left.length);
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

function replaceBuffer(buffer, pattern, replacement) {
  if (!Buffer.isBuffer(pattern) || pattern.length === 0 || buffer.length < pattern.length) return buffer;
  let offset = 0;
  let match = buffer.indexOf(pattern, offset);
  if (match < 0) return buffer;
  const parts = [];
  while (match >= 0) {
    if (match > offset) parts.push(buffer.subarray(offset, match));
    parts.push(replacement);
    offset = match + pattern.length;
    match = buffer.indexOf(pattern, offset);
  }
  if (offset < buffer.length) parts.push(buffer.subarray(offset));
  return Buffer.concat(parts);
}

function pathTextVariants(value) {
  const path = String(value);
  return [...new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])];
}

function replacePathText(text, value, replacement, platform) {
  let output = text;
  for (const variant of pathTextVariants(value)) {
    if (!variant) continue;
    if (platform === "win32") output = output.replace(new RegExp(escapeRegExp(variant), "gi"), replacement);
    else output = output.split(variant).join(replacement);
  }
  return output;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
