#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseVersion, requiresSoakForStable } from "./release-channel.mjs";
import { verifyCurrentStableSoak } from "./release-soak.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { createHardenedNpmSession } from "./hardened-npm-session.mjs";
import { normalizePackRecord, verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { stageAcceptedCandidateTarball } from "./accepted-candidate-tarball.mjs";
import { readPublishedNpmPrereleaseIfPresent } from "./published-release.mjs";
import { isTransientNetworkFailure } from "./network-retry.mjs";
import { releaseCommandFailure, releaseDiagnosticEvent } from "./release-diagnostic.mjs";
import { runExecutable } from "../src/local/shell.mjs";
import { sourceDependencyTreeInstallArguments, sourceDependencyTreeInstallTimeoutMs } from "./source-dependency-tree.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NPM_PUBLICATION_CONFIRMATION_FLAG = "--owner-confirm";
export const npmPrepublicationTimeoutMs = 30 * 60 * 1000;
export const npmPublicationStageTimeoutMs = 10 * 60 * 1000;

export function assertNpmPublicationAuthorized(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : process.argv.slice(2);
  if (!argv.includes(NPM_PUBLICATION_CONFIRMATION_FLAG)) {
    throw new Error(`npm publication requires explicit owner authorization represented by ${NPM_PUBLICATION_CONFIRMATION_FLAG}`);
  }
  return Object.freeze({ confirmation_flag: NPM_PUBLICATION_CONFIRMATION_FLAG });
}

export const npmPublicationConfirmationFlag = NPM_PUBLICATION_CONFIRMATION_FLAG;

export function npmPublishArguments(version, mode) {
  const parsed = parseReleaseVersion(version);
  if (mode === "prerelease" && !parsed.prerelease) throw new Error("prerelease publication requires a dev, beta, or rc version");
  if (mode === "stable" && parsed.prerelease) throw new Error("stable publication requires a version without a prerelease suffix");
  if (!new Set(["prerelease", "stable"]).has(mode)) throw new Error("publication mode must be prerelease or stable");
  return ["publish", "--dry-run=false", "--workspaces=false", "--global=false", "--ignore-scripts=true", "--if-present=false", "--logs-max=0", "--access=public", "--tag", parsed.npmTag];
}

export async function publishCurrentNpmPackage(repositoryRoot, mode, options = {}) {
  const repository = resolve(repositoryRoot);
  const pkg = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8"));
  const parsed = parseReleaseVersion(pkg.version);
  const publishArgs = npmPublishArguments(parsed.raw, mode);
  const explicitNpmCli = String(options.npmCli || "").trim();
  const lifecycleNpmCli = String(options.lifecycleNpmCli || process.env.npm_execpath || explicitNpmCli).trim();
  if (!lifecycleNpmCli) throw new Error("npm publication must run through npm so npm_execpath is available");
  const prepareCandidate = options.prepareCandidate || stageAcceptedCandidateTarball;
  const verifyAcceptance = options.verifyAcceptance || verifyCurrentReleaseAcceptance;

  const createSession = options.createSession || createHardenedNpmSession;
  const run = options.run || runNpmPublicationProcess;
  const prepublicationTimeout = positiveTimeout(options.prepublicationTimeoutMs, npmPrepublicationTimeoutMs);
  const publicationStageTimeout = positiveTimeout(options.publicationStageTimeoutMs, npmPublicationStageTimeoutMs);
  const processOptions = {
    cwd: repository,
    encoding: "utf8",
    env: nestedNpmEnvironment(options.env || process.env),
    stdio: options.capture ? "pipe" : "inherit",
    timeout: publicationStageTimeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  };
  let session = null;
  let acceptance = options.acceptance || null;
  let candidate = null;
  let publication = null;
  let primaryError = null;
  try {
    session = explicitNpmCli ? null : await createSession(options);
    const npmCli = explicitNpmCli || session.cli;
    await runNpmStage(run, npmCli, sourceDependencyTreeInstallArguments(repository), {
      ...processOptions,
      timeout: sourceDependencyTreeInstallTimeoutMs,
      stdio: "pipe",
    }, "npm source dependency installation");
    if (!parsed.prerelease && requiresSoakForStable(parsed.raw)) {
      verifyCurrentStableSoak(repository, { npmCli });
    }
    acceptance ??= verifyAcceptance(repository, {
      npmCli,
      env: options.env || process.env,
    });
    if (acceptance.required !== true) throw new Error("npm publication requires current local candidate acceptance");
    candidate = prepareCandidate(repository, acceptance, {
      ...options,
      npmCli,
      env: options.env || process.env,
    });
    if (!candidate?.path) throw new Error("npm publication candidate tarball path is missing");
    await runNpmStage(run, npmCli, [
      "run", "--dry-run=false", "--workspaces=false", "--global=false", "--ignore-scripts=false",
      "--if-present=false", "--logs-max=0", "--tag", parsed.npmTag, "--prefix", repository, "prepublishOnly",
    ], { ...processOptions, timeout: prepublicationTimeout }, "npm prepublication verification");
    const preflightArgs = [
      publishArgs[0], candidate.path,
      ...publishArgs.slice(1).map((value) => value === "--dry-run=false" ? "--dry-run=true" : value),
      "--json", "--prefix", repository,
    ];
    const preflight = await runNpmStage(run, npmCli, preflightArgs, { ...processOptions, stdio: "pipe" }, "npm publish dry-run");
    validateNpmPublishDryRun(preflight.stdout, acceptance.metadata);
    const readPublished = options.readPublished || ((name, version, tag) => readPublishedNpmPrereleaseIfPresent(
      name, version, tag, { npmCli, env: options.env || process.env },
    ));
    const preexisting = await readPublished(acceptance.metadata.package_name, parsed.raw, parsed.npmTag);
    if (preexisting) {
      assertPublishedCandidate(preexisting, acceptance.metadata, parsed.npmTag);
      publication = publicationResult(parsed, acceptance.metadata, { alreadyPublished: true });
    } else {
      let uploadError = null;
      try {
        const uploadOptions = { ...processOptions, stdio: npmPublicationUploadStdio(options) };
        await runNpmStage(run, npmCli, [
          publishArgs[0], candidate.path, ...publishArgs.slice(1), "--prefix", repository,
        ], uploadOptions, "npm publish");
      } catch (error) {
        uploadError = error;
      }
      let reconciled = null;
      let reconciliationError = null;
      try {
        reconciled = await waitForPublishedCandidate({
          readPublished,
          packageName: acceptance.metadata.package_name,
          version: parsed.raw,
          tag: parsed.npmTag,
          metadata: acceptance.metadata,
          attempts: options.reconciliationAttempts,
          wait: options.wait,
        });
      } catch (error) {
        reconciliationError = error;
      }
      if (reconciled) {
        publication = publicationResult(parsed, acceptance.metadata, {
          recovered: Boolean(uploadError),
          recoveryWarning: uploadError
            ? "npm upload returned an error, but the registry now exposes the exact accepted bytes"
            : "",
        });
      } else if (uploadError && reconciliationError) {
        throw new AggregateError(
          [uploadError, reconciliationError],
          "npm publication outcome is ambiguous because upload and registry reconciliation both failed",
        );
      } else if (uploadError?.code === "EOTP") {
        const error = new Error(
          "npm publication requires one-time authentication; the rejected upload did not produce a visible exact accepted version during bounded registry reconciliation. Re-run the canonical npm publication command in a real owner TTY and complete npm's browser/OTP challenge while that same command remains running; do not pass OTPs, tokens, or challenge URLs through automation",
        );
        error.code = "EOTP";
        throw error;
      } else if (uploadError) {
        throw new Error(
          "npm publication outcome is ambiguous: the upload command returned an error and the exact version is not yet visible; do not retry until registry state is checked",
          { cause: uploadError },
        );
      } else if (reconciliationError) {
        throw new Error(
          "npm upload returned success, but registry identity verification failed; publication state is ambiguous and must be checked before retrying",
          { cause: reconciliationError },
        );
      } else {
        throw new Error("npm upload returned success, but the exact accepted version is not yet visible in the registry; do not retry until registry state is checked");
      }
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = disposePublicationResources([session, candidate]);
  if (primaryError) {
    if (cleanupErrors.length) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "npm publication failed and temporary cleanup was incomplete",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length) publication.cleanupWarning = cleanupErrors.map(boundedCleanupWarning).join("; ").slice(0, 600);
  return publication;
}

function disposePublicationResources(resources) {
  const errors = [];
  for (const resource of resources) {
    try { resource?.dispose?.(); } catch (error) { errors.push(error); }
  }
  return errors;
}

export function validateNpmPublishDryRun(stdout, metadata) {
  let value;
  try { value = JSON.parse(String(stdout || "")); }
  catch { throw new Error("npm publish dry-run did not return valid JSON"); }
  const record = normalizePackRecord(value, metadata.package_name);
  if (!record) throw new Error("npm publish dry-run did not return package metadata");
  const expected = {
    name: metadata.package_name,
    version: metadata.package_version,
    filename: metadata.filename,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (String(record[key] || "") !== expectedValue) {
      throw new Error(`npm publish dry-run ${key} does not match the accepted candidate`);
    }
  }
  return Object.freeze(expected);
}

async function runNpmStage(run, npmCli, args, options, label) {
  const result = await run(process.execPath, [npmCli, ...args], options);
  if (result.error || result.status !== 0) {
    if (npmAuthenticationRequired(result)) {
      const error = new Error(`${label} requires npm one-time authentication`);
      error.code = "EOTP";
      error.transient = false;
      error.commandStatus = result.status;
      throw error;
    }
    const error = new Error(`${label} failed: ${releaseCommandFailure("npm", args, result, { maxChars: 1200 })}`, result.error ? { cause: result.error } : undefined);
    error.transient = isTransientNetworkFailure(result);
    error.commandStatus = result.status;
    throw error;
  }
  return result;
}

export function npmPublicationUploadStdio(options = {}) {
  if (options.capture === true) return "pipe";
  if (typeof options.interactiveTty === "boolean") return options.interactiveTty ? "inherit" : "pipe";
  return process.stdin?.isTTY === true && process.stdout?.isTTY === true && process.stderr?.isTTY === true ? "inherit" : "pipe";
}

export function npmAuthenticationRequired(result) {
  if (String(result?.error?.code || "").toUpperCase() === "EOTP") return true;
  const evidence = [result?.stderr, result?.stdout, result?.error?.message].filter(Boolean).join("\n");
  return /\bEOTP\b|one-time password|authenticate your account at/i.test(evidence);
}

export async function runNpmPublicationProcess(command, args, options = {}) {
  try {
    const result = await runExecutable(command, args, {
      cwd: options.cwd,
      env: options.env,
      capture: options.stdio === "pipe",
      maxOutputBytes: options.maxBuffer,
      timeoutMs: positiveTimeout(options.timeout, npmPublicationStageTimeoutMs),
      allowFailure: true,
      hardTimeout: true,
    });
    if (result.timed_out === true) {
      const settled = result.termination_settled !== false;
      const error = Object.assign(new Error(settled
        ? "npm publication process exceeded its stage deadline"
        : "npm publication process exceeded its stage deadline and process-tree termination could not be confirmed"), {
        code: settled ? "ETIMEDOUT" : "EUNSETTLED",
      });
      return { status: null, signal: "SIGKILL", stdout: result.stdout, stderr: result.stderr, error };
    }
    return { status: result.code, signal: null, stdout: result.stdout, stderr: result.stderr, error: null };
  } catch (error) {
    return { status: null, signal: null, stdout: "", stderr: "", error };
  }
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function publicationResult(parsed, metadata, options = {}) {
  return {
    version: parsed.raw,
    tag: parsed.npmTag,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
    alreadyPublished: options.alreadyPublished === true,
    recovered: options.recovered === true,
    recoveryWarning: String(options.recoveryWarning || ""),
    cleanupWarning: "",
  };
}

async function waitForPublishedCandidate({
  readPublished, packageName, version, tag, metadata, attempts = 5, wait = defaultPublicationWait,
}) {
  const maximumAttempts = Number.isSafeInteger(Number(attempts))
    ? Math.min(Math.max(Number(attempts), 1), 10)
    : 5;
  const pause = typeof wait === "function" ? wait : defaultPublicationWait;
  let lastTransientError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const published = await readPublished(packageName, version, tag);
      if (published) return assertPublishedCandidate(published, metadata, tag);
    } catch (error) {
      const eventuallyConsistent = new Set(["npm_dist_tag_mismatch", "npm_publication_metadata_incomplete"]);
      if (error?.transient !== true && !eventuallyConsistent.has(String(error?.code || ""))) throw error;
      lastTransientError = error;
    }
    if (attempt < maximumAttempts) await pause(attempt);
  }
  if (lastTransientError) throw lastTransientError;
  return null;
}

function assertPublishedCandidate(published, metadata, tag) {
  if (published.version !== metadata.package_version
      || published.shasum !== metadata.shasum
      || published.integrity !== metadata.integrity
      || published.distTag !== tag) {
    throw new Error("npm registry version or dist-tag does not match the exact accepted candidate");
  }
  return published;
}

function defaultPublicationWait(attempt) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(4_000, attempt * 1_000)); });
}

function boundedCleanupWarning(error) {
  return String(error?.message || error || "temporary cleanup failed")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 600);
}

async function main() {
  const mode = process.argv[2] || "";
  assertNpmPublicationAuthorized();
  const result = await publishCurrentNpmPackage(root, mode);
  if (result.recoveryWarning) console.warn(result.recoveryWarning);
  if (result.cleanupWarning) console.warn(`npm publication succeeded but temporary hardened npm cleanup was incomplete: ${result.cleanupWarning}`);
  const disposition = result.alreadyPublished ? "already matched" : result.recovered ? "reconciled" : "completed";
  console.log(`npm publication ${disposition}: ${result.version} with dist-tag ${result.tag}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify(releaseDiagnosticEvent("npm.publish.failed", error?.message || error, 1600)));
    process.exitCode = 1;
  });
}
