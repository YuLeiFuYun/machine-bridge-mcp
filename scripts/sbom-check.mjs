import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { releaseCommandFailure } from "./release-diagnostic.mjs";

const MAX_SBOM_BYTES = 4 * 1024 * 1024;
const SBOM_TIMEOUT_MS = 30_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function generateAndValidateSbom(options = {}) {
  const npmCli = String(options.npmCli || process.env.npm_execpath || "").trim();
  if (!npmCli) throw new Error("sbom check must run through an npm lifecycle so npm_execpath is available");
  const cwd = resolve(options.cwd || root);
  const result = spawnSync(process.execPath, [npmCli, "sbom", "--workspaces=false", "--global=false", "--prefix", root, "--sbom-format", "cyclonedx"], {
    cwd,
    env: nestedNpmEnvironment(options.env || process.env),
    encoding: "utf8",
    maxBuffer: MAX_SBOM_BYTES,
    timeout: SBOM_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("npm", ["sbom"], result));
  if (Buffer.byteLength(result.stdout) > MAX_SBOM_BYTES) throw new Error("npm sbom output exceeds the fixed byte budget");
  let document;
  try { document = JSON.parse(result.stdout); }
  catch { throw new Error("npm sbom did not return valid JSON"); }
  return validateCycloneDxSbom(document, {
    packageName: options.packageName || packageJson.name,
    packageVersion: options.packageVersion || packageJson.version,
    forbiddenPaths: options.forbiddenPaths || [cwd, homedir()],
  });
}

export function validateCycloneDxSbom(document, options = {}) {
  if (!isRecord(document)) throw new Error("SBOM root must be an object");
  if (document.bomFormat !== "CycloneDX" || document.specVersion !== "1.5") {
    throw new Error("SBOM must be CycloneDX 1.5");
  }
  const component = isRecord(document.metadata) && isRecord(document.metadata.component)
    ? document.metadata.component
    : null;
  const packageName = String(options.packageName || "");
  const packageVersion = String(options.packageVersion || "");
  if (!component || component.name !== packageName || component.version !== packageVersion) {
    throw new Error("SBOM metadata component does not match the current package identity");
  }
  if (!Array.isArray(document.components) || document.components.length < 1 || document.components.length > 10_000) {
    throw new Error("SBOM components must be a non-empty bounded array");
  }
  if (!Array.isArray(document.dependencies) || document.dependencies.length < 1 || document.dependencies.length > 20_000) {
    throw new Error("SBOM dependencies must be a non-empty bounded array");
  }
  const rootReference = String(component["bom-ref"] || "");
  if (!rootReference) throw new Error("SBOM root component reference is missing");
  const references = new Set([rootReference]);
  for (const item of document.components) {
    if (!isRecord(item) || typeof item["bom-ref"] !== "string" || !item["bom-ref"]
        || typeof item.name !== "string" || !item.name || typeof item.version !== "string" || !item.version) {
      throw new Error("SBOM contains an invalid component record");
    }
    if (references.has(item["bom-ref"])) throw new Error("SBOM contains duplicate component references");
    references.add(item["bom-ref"]);
  }
  const dependencyByReference = new Map();
  for (const entry of document.dependencies) {
    if (!isRecord(entry) || typeof entry.ref !== "string" || !references.has(entry.ref)
        || dependencyByReference.has(entry.ref) || !Array.isArray(entry.dependsOn)
        || entry.dependsOn.some((reference) => typeof reference !== "string" || !references.has(reference))) {
      throw new Error("SBOM dependency graph contains an invalid reference");
    }
    dependencyByReference.set(entry.ref, entry.dependsOn);
  }
  if (dependencyByReference.size !== references.size
      || [...references].some((reference) => !dependencyByReference.has(reference))) {
    throw new Error("SBOM dependency graph omits a component reference");
  }
  const serialized = JSON.stringify(document);
  for (const path of options.forbiddenPaths || []) {
    const candidate = String(path || "");
    if (candidate && candidate.length >= 2 && serialized.includes(candidate)) {
      throw new Error("SBOM contains a local filesystem path");
    }
  }
  return Object.freeze({
    bom_format: document.bomFormat,
    spec_version: document.specVersion,
    package: `${packageName}@${packageVersion}`,
    components: document.components.length,
    dependencies: document.dependencies.length,
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const summary = generateAndValidateSbom();
  process.stdout.write(`CycloneDX SBOM validated (${summary.components} components, ${summary.dependencies} dependencies)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
