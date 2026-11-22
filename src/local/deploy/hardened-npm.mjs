import https from "node:https";
import path, { isAbsolute, join } from "node:path";
import { resolveTrustedExecutable } from "../core/trusted-executable.mjs";
import { lstatSync, existsSync, renameSync, rmSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { replaceFileAtomicallySync } from "../core/exclusive-file.mjs";
import { privateToolchainIntegrityError, throwOperationalOrIntegrity, isPrivateToolchainIntegrityError } from "./cf-network-integrity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const DEFAULT_MAXIMUM_DURATION_MS = 300_000;

export function createHardenedDownloadTimeout(artifactName, request, options = {}) {
  const schedule = typeof options.schedule === "function" ? options.schedule : setTimeout;
  const cancel = typeof options.cancel === "function" ? options.cancel : clearTimeout;
  const idleMs = boundedDuration(options.idleMs, DEFAULT_IDLE_TIMEOUT_MS, 1, DEFAULT_IDLE_TIMEOUT_MS);
  const maximumMs = boundedDuration(options.maximumMs, DEFAULT_MAXIMUM_DURATION_MS, idleMs, DEFAULT_MAXIMUM_DURATION_MS);
  let idleTimer = null;
  let maximumTimer = null;
  let finished = false;

  const cancelTimers = () => {
    if (idleTimer !== null) cancel(idleTimer);
    if (maximumTimer !== null) cancel(maximumTimer);
    idleTimer = null;
    maximumTimer = null;
  };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    cancelTimers();
    request.destroy(Object.assign(new Error(`${artifactName} tarball ${message}`), { code: "ETIMEDOUT" }));
  };
  const armIdle = () => {
    if (finished) return;
    if (idleTimer !== null) cancel(idleTimer);
    idleTimer = schedule(() => fail("download stalled"), idleMs);
  };

  maximumTimer = schedule(() => fail("download exceeded its maximum duration"), maximumMs);
  armIdle();
  return Object.freeze({
    progress: armIdle,
    clear() {
      finished = true;
      cancelTimers();
    },
  });
}

function boundedDuration(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;

const DOWNLOAD_ATTEMPTS = 3;

const RETRY_BASE_MS = 750;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const CONTROL_CHARACTERS = /[\0\r\n]/;

const PROXY_URL_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];

const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "ECONNABORTED", "EPIPE"]);

export async function downloadHardenedNpmArtifact(artifact, options = {}) {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try { return await downloadAttempt(artifact, options); }
    catch (error) {
      if (attempt === DOWNLOAD_ATTEMPTS || !retryableDownloadError(error)) throw error;
      await retryDelay(attempt, options);
    }
  }
  throw new Error(`${artifact.name} tarball download exhausted retries`);
}

function downloadAttempt(artifact, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(artifact.url);
    if (target.protocol !== "https:" || target.username || target.password || target.port || target.search || target.hash) {
      rejectPromise(new Error(`${artifact.name} tarball URL is not an exact HTTPS registry URL`)); return;
    }
    let context = null;
    let request;
    try {
      context = prepareRequestAgent(target, options);
      const requestFn = typeof options.request === "function" ? options.request : https.request;
      request = requestFn({
        protocol: target.protocol, hostname: target.hostname, method: "GET", path: target.pathname,
        headers: { Accept: "application/octet-stream", "User-Agent": "machine-bridge-mcp-hardened-npm" },
        ...(context.agent ? { agent: context.agent } : {}),
      });
    } catch (error) { rejectPromise(cleanupResult(context, error, `${artifact.name} tarball download setup failed`)); return; }
    let settled = false;
    const timeout = createHardenedDownloadTimeout(artifact.name, request, options.downloadTimeout);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; timeout.clear();
      const outcome = cleanupResult(context, error, `${artifact.name} tarball download failed`);
      if (outcome) rejectPromise(outcome); else resolvePromise(value);
    };
    request.once("error", (error) => finish(error));
    request.once("response", (response) => {
      timeout.progress(); const status = Number(response.statusCode || 0);
      if (status !== 200) {
        response.resume();
        finish(Object.assign(new Error(`failed to download ${artifact.name} ${artifact.version}: HTTP ${status || "unknown"}`), { statusCode: status })); return;
      }
      const declaredBytes = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.maximumBytes) {
        response.destroy(); finish(new Error(`${artifact.name} tarball exceeds its byte limit`)); return;
      }
      const chunks = []; let total = 0;
      response.on("data", (chunk) => {
        timeout.progress(); const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += buffer.length;
        if (total > artifact.maximumBytes || total > MAX_DOWNLOAD_BYTES) {
          response.destroy(Object.assign(new Error(`${artifact.name} tarball exceeds its byte limit`), { code: "ERR_RESPONSE_TOO_LARGE" })); return;
        }
        chunks.push(buffer);
      });
      response.once("error", (error) => finish(error)); response.once("aborted", () => finish(Object.assign(new Error(`${artifact.name} tarball response aborted`), { code: "ECONNRESET" })));
      response.once("end", () => finish(null, Buffer.concat(chunks, total)));
    });
    try { request.end(); } catch (error) { finish(error); }
  });
}

function prepareRequestAgent(target, options) {
  if (typeof options.proxyAgentForUrl === "function") return { agent: options.proxyAgentForUrl(target.href, options.proxyResolver)?.agent || null };
  if (Object.hasOwn(options, "agent")) return { agent: options.agent || null };
  const proxyEnv = normalizeProxyEnvironment(options.proxyEnv ?? process.env);
  const agent = (typeof options.createAgent === "function" ? options.createAgent : proxyAgentForHttp)(proxyEnv);
  if (!agent || typeof agent !== "object") throw new Error("hardened npm proxy agent could not be initialized");
  return { agent, dispose: typeof agent.destroy === "function" ? () => agent.destroy() : null };
}

function normalizeProxyEnvironment(source) {
  if (!source || typeof source !== "object") throw proxyConfigurationError("HTTP proxy environment must be an object");
  const normalized = {};
  for (const key of PROXY_URL_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "string") throw proxyConfigurationError("HTTP proxy configuration must be a string"); const value = source[key].trim();
    if (!value) { normalized[key] = ""; continue; }
    if (CONTROL_CHARACTERS.test(value)) throw proxyConfigurationError("HTTP proxy configuration contains a prohibited control character");
    let proxyUrl; try { proxyUrl = new URL(value); } catch { throw proxyConfigurationError("HTTP proxy configuration is not a valid URL"); }
    if (!HTTP_PROTOCOLS.has(proxyUrl.protocol)) throw proxyConfigurationError("HTTP proxy configuration must use HTTP or HTTPS");
    normalized[key] = proxyUrl.href;
  }
  for (const key of NO_PROXY_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "string") throw proxyConfigurationError("NO_PROXY configuration must be a string"); const value = source[key];
    if (CONTROL_CHARACTERS.test(value)) throw proxyConfigurationError("NO_PROXY configuration contains a prohibited control character");
    normalized[key] = value;
  }
  return normalized;
}

function retryableDownloadError(error) {
  const status = Number(error?.statusCode || 0);
  return TRANSIENT_NETWORK_CODES.has(String(error?.code || "")) || String(error?.message || "").trim().toLowerCase() === "aborted" || status === 429 || (status >= 500 && status <= 599);
}

function retryDelay(attempt, options) {
  const milliseconds = Math.min(RETRY_BASE_MS * attempt, 3_000);
  return typeof options.sleep === "function" ? Promise.resolve(options.sleep(milliseconds)) : new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}

function proxyAgentForHttp(proxyEnv) { return new https.Agent({ proxyEnv }); }

function proxyConfigurationError(message) { return Object.assign(new Error(message), { code: "http_proxy_configuration" }); }

function cleanupResult(context, primary, message) {
  try { context?.dispose?.(); return primary; }
  catch (cleanup) { return primary ? new AggregateError([primary, cleanup], `${message} and proxy-agent cleanup was incomplete`) : cleanup; }
}
export function resolveHardenedNpmTarExecutable(stateRoot, options = {}) {
  const windowsRoot = String(options.windowsRoot || process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
  return resolveTrustedExecutable({
    platform: options.platform,
    candidates: [
      options.tarExecutable,
      path.join(windowsRoot, "System32", "tar.exe"),
      "/usr/bin/tar",
      "/bin/tar",
      "/usr/local/bin/tar",
    ].filter(Boolean),
    stateRoot,
    home: options.home,
    label: "tar extractor",
    reason: "trusted_tar_unavailable",
  });
}
const MAX_MARKER_BYTES = 16 * 1024;

const HARDENED_NPM_MARKER = ".machine-bridge-mcp-hardened-npm.json";

export function verifyHardenedNpmTree(root, artifacts, execute) {
  const target = path.resolve(root);
  ensureOwnerOnlyDirectorySync(target);
  const npmRoot = path.join(target, "package");
  const nodeModules = path.join(npmRoot, "node_modules");
  requireRealDirectory(npmRoot, "hardened npm package root");
  requireRealDirectory(nodeModules, "hardened npm node_modules");
  verifyHardenedPackageIdentity(npmRoot, "npm", artifacts[0].version);
  verifyHardenedPackageIdentity(path.join(nodeModules, "undici"), "undici", artifacts[1].version);
  verifyHardenedPackageIdentity(path.join(nodeModules, "brace-expansion"), "brace-expansion", artifacts[2].version);
  const binRoot = path.join(npmRoot, "bin");
  requireRealDirectory(binRoot, "hardened npm bin directory");
  const cli = path.join(binRoot, "npm-cli.js");
  let info;
  try { info = lstatSync(cli); }
  catch (error) { throwOperationalOrIntegrity(error, "hardened npm CLI is missing or unreadable"); }
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1 || (process.platform !== "win32" && (Number(info.mode) & 0o022) !== 0)) {
    throw privateToolchainIntegrityError("hardened npm CLI is not a private real regular file");
  }
  const reported = String(execute(process.execPath, [cli, "--version"], { capture: true })).trim();
  if (reported !== artifacts[0].version) {
    throw privateToolchainIntegrityError(`hardened npm CLI reported ${reported || "no version"}`);
  }
  return Object.freeze({
    cli,
    version: artifacts[0].version,
    undiciVersion: artifacts[1].version,
    braceExpansionVersion: artifacts[2].version,
  });
}

function requireRealDirectory(directory, label) {
  let info;
  try { info = lstatSync(directory); }
  catch (error) { throwOperationalOrIntegrity(error, `${label} is missing or unreadable`); }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw privateToolchainIntegrityError(`${label} is not a real directory`);
  }
}

export function readHardenedNpmMarker(root) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(path.join(root, HARDENED_NPM_MARKER), MAX_MARKER_BYTES, "hardened npm marker", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throwOperationalOrIntegrity(error, "hardened npm marker is structurally invalid");
  }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw privateToolchainIntegrityError("hardened npm marker is not valid JSON", error); }
}

export function hardenedNpmMarkerMatches(marker, identity) {
  return marker?.schema_version === 1
    && marker.digest === identity.digest
    && marker.npm === identity.npmVersion
    && marker.undici === identity.undiciVersion
    && marker.brace_expansion === identity.braceExpansionVersion;
}

export function writeHardenedNpmMarker(root, identity) {
  replaceFileAtomicallySync(path.join(root, HARDENED_NPM_MARKER), `${JSON.stringify({
    schema_version: 1,
    digest: identity.digest,
    npm: identity.npmVersion,
    undici: identity.undiciVersion,
    brace_expansion: identity.braceExpansionVersion,
  }, null, 2)}\n`, { mode: 0o600 });
}

export function verifyHardenedPackageIdentity(directory, name, version) {
  requireRealDirectory(directory, `${name} package directory`);
  const file = path.join(directory, "package.json");
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(file, 2 * 1024 * 1024, `${name} package manifest`, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    throwOperationalOrIntegrity(error, `${name} package manifest is missing or structurally invalid`);
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw privateToolchainIntegrityError(`${name} package manifest is not valid JSON`, error); }
  if (manifest?.name !== name || manifest?.version !== version) {
    throw privateToolchainIntegrityError(`${name} package identity does not match ${version}`);
  }
}
export const HARDENED_NPM_BRACE_EXPANSION_ARTIFACT = Object.freeze({
  name: "brace-expansion",
  version: "5.0.12",
  url: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
  integrity: "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==",
  maximumBytes: 1024 * 1024,
});

export const HARDENED_NPM_ARTIFACTS = Object.freeze([
  Object.freeze({
    name: "npm",
    version: "12.0.2",
    url: "https://registry.npmjs.org/npm/-/npm-12.0.2.tgz",
    integrity: "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==",
    maximumBytes: 20 * 1024 * 1024,
  }),
  Object.freeze({
    name: "undici",
    version: "6.28.0",
    url: "https://registry.npmjs.org/undici/-/undici-6.28.0.tgz",
    integrity: "sha512-LIY910g9TI13YS95lrMFrs8Rm/u/irgHeTWoKCoteeJ04CUJ92eEfj0rVn+7VKMPBpUPiUoBKfhNyLI23EE/KA==",
    maximumBytes: 4 * 1024 * 1024,
  }),
  HARDENED_NPM_BRACE_EXPANSION_ARTIFACT,
]);

export function hardenedNpmIdentity(artifacts = HARDENED_NPM_ARTIFACTS) {
  const normalized = normalizeArtifacts(artifacts);
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze({
    npmVersion: normalized[0].version,
    undiciVersion: normalized[1].version,
    braceExpansionVersion: normalized[2].version,
    digest,
    directoryName: `npm-${normalized[0].version}-hardened-${digest.slice(0, 16)}`,
  });
}

export async function ensureHardenedNpm(parent, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  const identity = hardenedNpmIdentity(artifacts);
  const root = path.join(path.resolve(parent), identity.directoryName);
  ensureOwnerOnlyDirectorySync(path.dirname(root));
  let integrityError = null;
  try {
    const verified = verifyHardenedNpm(root, { artifacts, run: options.run });
    const marker = readHardenedNpmMarker(root);
    if (hardenedNpmMarkerMatches(marker, identity)) return Object.freeze({ ...verified, root, identity });
  } catch (error) {
    if (!isPrivateToolchainIntegrityError(error)) throw error;
    integrityError = error;
    // Only positively identified private-copy corruption is reconstructed below.
  }
  if (existsSync(root)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (error) {
      if (integrityError) {
        throw new AggregateError([integrityError, error], "hardened npm is corrupt and private-copy removal was incomplete");
      }
      throw error;
    }
  }
  ensureOwnerOnlyDirectorySync(root);
  try {
    await prepareHardenedNpm(root, { ...options, artifacts });
    const verified = verifyHardenedNpm(root, { artifacts, run: options.run });
    writeHardenedNpmMarker(root, identity);
    return Object.freeze({ ...verified, root, identity });
  } catch (error) {
    let cleanupError = null;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (failure) { cleanupError = failure; }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "hardened npm preparation failed and private-copy cleanup was incomplete");
    }
    throw error;
  }
}

export async function prepareHardenedNpm(root, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  const target = path.resolve(root);
  ensureOwnerOnlyDirectorySync(target);
  const tarExecutable = resolveHardenedNpmTarExecutable(target, options);
  const archives = path.join(target, ".archives");
  ensureOwnerOnlyDirectorySync(archives);
  let primaryError = null;
  try {
    for (const artifact of artifacts) {
      const bytes = await readArtifact(artifact, options);
      verifyArtifact(bytes, artifact);
      const archive = path.join(archives, `${artifact.name}-${artifact.version}.tgz`);
      writeFileSync(archive, bytes, { mode: 0o600 });
      const extracted = path.join(archives, `extract-${artifact.name}`);
      ensureOwnerOnlyDirectorySync(extracted);
      run(options.run, tarExecutable, ["-xzf", archive, "-C", extracted]);
      const packageDirectory = path.join(extracted, "package");
      verifyHardenedPackageIdentity(packageDirectory, artifact.name, artifact.version);
      if (artifact.name === "npm") {
        const destination = path.join(target, "package");
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(packageDirectory, destination);
      } else {
        const destination = path.join(target, "package", "node_modules", artifact.name);
        if (!existsSync(path.dirname(destination))) throw new Error(`hardened npm is missing the ${artifact.name} dependency parent`);
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(packageDirectory, destination);
      }
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { rmSync(archives, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "hardened npm extraction failed and archive cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return verifyHardenedNpm(target, { artifacts, run: options.run });
}

export function verifyHardenedNpm(root, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts || HARDENED_NPM_ARTIFACTS);
  return verifyHardenedNpmTree(root, artifacts, (command, args, runOptions) => run(options.run, command, args, runOptions));
}

async function readArtifact(artifact, options) {
  if (typeof options.readArtifact === "function") {
    const value = await options.readArtifact(artifact);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  return downloadHardenedNpmArtifact(artifact, options);
}

function verifyArtifact(bytes, artifact) {
  if (bytes.length > artifact.maximumBytes) throw new Error(`${artifact.name} tarball exceeds its byte limit`);
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(artifact.integrity);
  if (!match) throw new Error(`${artifact.name} integrity is not valid SHA-512 SRI`);
  const actual = createHash("sha512").update(bytes).digest();
  const expected = Buffer.from(match[1], "base64");
  if (actual.length !== expected.length || !actual.equals(expected)) throw new Error(`${artifact.name} tarball failed SHA-512 verification`);
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("hardened npm requires exactly three pinned artifacts");
  const artifacts = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.name !== "string" || typeof item.version !== "string"
        || typeof item.url !== "string" || typeof item.integrity !== "string"
        || !Number.isSafeInteger(item.maximumBytes)) {
      throw new Error("hardened npm artifact metadata must use exact string/integer types");
    }
    return Object.freeze({ name: item.name, version: item.version, url: item.url, integrity: item.integrity, maximumBytes: item.maximumBytes });
  });
  if (artifacts.map((item) => item.name).join(",") !== "npm,undici,brace-expansion") {
    throw new Error("hardened npm artifact order or names are invalid");
  }
  for (const artifact of artifacts) {
    let target;
    try { target = new URL(artifact.url); } catch { throw new Error(`hardened npm artifact URL is invalid for ${artifact.name}`); }
    const expectedPath = `/${artifact.name}/-/${artifact.name}-${artifact.version}.tgz`;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version)
        || target.origin !== "https://registry.npmjs.org" || target.pathname !== expectedPath
        || target.username || target.password || target.search || target.hash
        || !Number.isSafeInteger(artifact.maximumBytes) || artifact.maximumBytes < 1) {
      throw new Error(`hardened npm artifact metadata is invalid for ${artifact.name}`);
    }
  }
  return artifacts;
}

function run(injected, command, args, options = {}) {
  if (typeof injected === "function") return injected(command, args, options);
  const result = spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${String(result.stderr || result.stdout || "").trim().slice(0, 1000)}`);
  return options.capture ? String(result.stdout || "") : "";
}
export function createHardenedNpmLauncher(parent, cli) {
  if (typeof parent !== "string" || !isAbsolute(parent)
    || typeof cli !== "string" || !isAbsolute(cli) || /[\0\r\n]/.test(cli)) {
    throw new TypeError("hardened npm launcher requires absolute paths");
  }
  const windows = process.platform === "win32";
  const quote = windows ? cmdQuote : shellQuote;
  const command = windows
    ? `@echo off\r\n"${quote(process.execPath)}" "${quote(cli)}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
  const bin = mkdtempSync(join(parent, "npm-bin-"));
  try {
    const wrapper = join(bin, windows ? "npm.cmd" : "npm");
    writeFileSync(wrapper, command, { flag: "wx", mode: 0o700 });
    if (!windows) chmodSync(wrapper, 0o700);
    return bin;
  } catch (error) {
    try { rmSync(bin, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "hardened npm launcher creation and cleanup failed"); }
    throw error;
  }
}

export async function withHardenedNpmLauncher(parent, cli, callback) {
  const bin = createHardenedNpmLauncher(parent, cli);
  let result, primaryError, failed = false;
  try { result = await callback(bin); } catch (error) { failed = true; primaryError = error; }
  try { rmSync(bin, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (cleanupError) {
    if (failed) throw new AggregateError([primaryError, cleanupError], "hardened npm operation and launcher cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primaryError;
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(value) {
  const text = String(value);
  if (/[\0\r\n"%&|<>^!]/.test(text)) throw new Error("Windows wrapper path contains an unsupported character");
  return text;
}
