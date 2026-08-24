import { resolve } from "node:path";

export function managedJobResourcePathVariants(value, platform = process.platform) {
  const canonical = resolve(value);
  const variants = new Set(pathTextVariants(canonical));
  if (platform === "darwin" && canonical.startsWith("/private/")) {
    for (const variant of pathTextVariants(canonical.slice("/private".length))) variants.add(variant);
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

export function redactManagedJobOutput(buffer, context, runtimeDir, platform = process.platform) {
  let text = new TextDecoder("utf-8").decode(buffer);
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
