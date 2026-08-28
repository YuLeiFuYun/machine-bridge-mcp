import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNpmPublicationAuthorized,
  npmAuthenticationRequired,
  npmPrepublicationTimeoutMs,
  npmPublicationConfirmationFlag,
  npmPublicationStageTimeoutMs,
  npmPublicationUploadStdio,
  npmPublishArguments,
  publishCurrentNpmPackage,
  runNpmPublicationProcess,
} from "../scripts/publish-npm.mjs";

expectThrow(() => assertNpmPublicationAuthorized({ argv: ["prerelease"] }), "explicit owner authorization");
assert(
  assertNpmPublicationAuthorized({ argv: ["prerelease", npmPublicationConfirmationFlag] }).confirmation_flag
    === npmPublicationConfirmationFlag,
  "npm publication confirmation flag was not accepted",
);

const publishBase = [
  "publish", "--dry-run=false", "--workspaces=false", "--global=false",
  "--ignore-scripts=true", "--if-present=false", "--logs-max=0", "--access=public", "--tag",
];
assert(JSON.stringify(npmPublishArguments("3.0.0-beta.1", "prerelease")) === JSON.stringify([...publishBase, "beta"]), "beta publish arguments are incorrect");
assert(JSON.stringify(npmPublishArguments("3.0.0-rc.1", "prerelease")) === JSON.stringify([...publishBase, "next"]), "rc publish arguments are incorrect");
assert(JSON.stringify(npmPublishArguments("3.0.0", "stable")) === JSON.stringify([...publishBase, "latest"]), "stable publish arguments are incorrect");
expectThrow(() => npmPublishArguments("3.0.0", "prerelease"), "requires a dev, beta, or rc");
expectThrow(() => npmPublishArguments("3.0.0-beta.1", "stable"), "without a prerelease suffix");
assert(npmPublicationUploadStdio({ interactiveTty: true }) === "inherit"
  && npmPublicationUploadStdio({ interactiveTty: false }) === "pipe"
  && npmPublicationUploadStdio({ interactiveTty: true, capture: true }) === "pipe",
"npm publication upload TTY selection is incorrect");
assert(npmAuthenticationRequired({ status: 1, stderr: "npm error code EOTP\nAuthenticate your account at https://example.invalid/auth/cli/secret" })
  && !npmAuthenticationRequired({ status: 1, stderr: "npm error code E404" }),
"npm authentication-required classification is incorrect");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const accepted = {
  required: true,
  metadata: {
    package_name: "machine-bridge-mcp",
    package_version: "3.0.0-beta.43",
    filename: "machine-bridge-mcp-3.0.0-beta.43.tgz",
    shasum: "a".repeat(40),
    integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
  },
  record: { promotion_content_sha256: "b".repeat(64) },
};
const candidatePath = "/synthetic/machine-bridge-mcp-3.0.0-beta.43.tgz";
const acceptedOptions = {
  acceptance: accepted,
  prepareCandidate: () => ({ path: candidatePath, dispose() {} }),
  lifecycleNpmCli: "/synthetic/lifecycle/npm-cli.js",
  reconciliationAttempts: 2,
  wait: async () => {},
};
const invocations = [];
let publicationReads = 0;
const published = await publishCurrentNpmPackage(root, "prerelease", {
  ...acceptedOptions,
  npmCli: "/synthetic/hardened/npm-cli.js",
  capture: true,
  env: {
    PATH: "/example/bin",
    NPM_CONFIG_DRY_RUN: "true",
    NPM_CONFIG_WORKSPACES: "true",
    npm_config_registry: "https://registry.example.test",
  },
  run(command, args, options) {
    invocations.push({ command, args, options });
    return successfulStage(args);
  },
  readPublished() {
    publicationReads += 1;
    return publicationReads === 1 ? null : publishedRecord();
  },
});
assert(published.tag === "beta" && published.shasum === accepted.metadata.shasum,
  "npm publication did not retain accepted artifact identity");
assert(invocations.length === 3, "npm publication did not separate verification, dry-run, and exact upload stages");
const [verification, preflight, publication] = invocations;
assert(verification.args[0] === "/synthetic/hardened/npm-cli.js"
  && verification.args[1] === "run"
  && verification.args.includes("prepublishOnly")
  && verification.args.includes("--ignore-scripts=false")
  && verification.args.includes("--if-present=false")
  && verification.args.includes("--logs-max=0")
  && verification.args.includes("--tag")
  && verification.args.includes("beta"),
"npm prepublication verification did not run through the supplied hardened CLI");
assert(verification.options.timeout === npmPrepublicationTimeoutMs
  && npmPrepublicationTimeoutMs === 30 * 60 * 1000,
"npm prepublication verification lost the full-plan release deadline budget");
assert(preflight.args[1] === "publish"
  && preflight.args[2] === candidatePath
  && preflight.args.includes("--dry-run=true")
  && preflight.args.includes("--json"),
"npm publication did not validate npm's exact tarball interpretation before upload");
assert(preflight.options.timeout === npmPublicationStageTimeoutMs
  && publication.options.timeout === npmPublicationStageTimeoutMs,
"npm dry-run or upload inherited the longer full-verification deadline");
assert(publication.args[1] === "publish"
  && publication.args[2] === candidatePath
  && publication.args.includes("--ignore-scripts=true")
  && publication.args.includes("--logs-max=0")
  && publication.args.includes("--prefix")
  && publication.args.includes(root),
"npm publication did not publish the exact accepted tarball with lifecycle scripts disabled");
assert(publication.options.stdio === "pipe", "captured npm publication unexpectedly exposed raw upload output");
assert(!Object.hasOwn(publication.options.env, "NPM_CONFIG_DRY_RUN")
  && !Object.hasOwn(publication.options.env, "NPM_CONFIG_WORKSPACES")
  && publication.options.env.npm_config_registry === "https://registry.example.test",
"npm publication retained inherited execution modes or removed registry configuration");

let failedVerificationCalls = 0;
await assertRejects(
  () => publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    npmCli: "/synthetic/hardened/npm-cli.js",
    run() {
      failedVerificationCalls += 1;
      return { status: 1, stdout: "", stderr: "verification failed" };
    },
  }),
  "npm prepublication verification failed",
);
assert(failedVerificationCalls === 1, "npm publish was attempted after prepublication verification failed");

let mismatchedPreflightCalls = 0;
await assertRejects(
  () => publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    npmCli: "/synthetic/hardened/npm-cli.js",
    run(command, args) {
      mismatchedPreflightCalls += 1;
      if (args.includes("--dry-run=true")) {
        return { status: 0, stdout: publishDryRunJson({ shasum: "f".repeat(40) }), stderr: "" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    },
  }),
  "dry-run shasum does not match",
);
assert(mismatchedPreflightCalls === 2, "npm upload was attempted after dry-run artifact identity mismatch");

const preexistingInvocations = [];
const preexisting = await publishCurrentNpmPackage(root, "prerelease", {
  ...acceptedOptions,
  npmCli: "/synthetic/hardened/npm-cli.js",
  capture: true,
  run(command, args, options) {
    preexistingInvocations.push({ command, args, options });
    return successfulStage(args);
  },
  readPublished: () => publishedRecord(),
});
assert(preexisting.alreadyPublished === true && preexistingInvocations.length === 2,
  "exact preexisting npm version was uploaded again instead of settling idempotently");

let eventualReads = 0;
const eventualPublication = await publishCurrentNpmPackage(root, "prerelease", {
  ...acceptedOptions,
  npmCli: "/synthetic/hardened/npm-cli.js",
  capture: true,
  run(command, args) { return successfulStage(args); },
  readPublished() {
    eventualReads += 1;
    if (eventualReads === 1) return null;
    if (eventualReads === 2) throw Object.assign(new Error("tag has not converged"), { code: "npm_dist_tag_mismatch" });
    return publishedRecord();
  },
});
assert(eventualPublication.recovered === false && eventualReads === 3,
  "npm publication did not wait for bounded dist-tag convergence after upload");

let recoveredReads = 0;
const recoveredPublication = await publishCurrentNpmPackage(root, "prerelease", {
  ...acceptedOptions,
  npmCli: "/synthetic/hardened/npm-cli.js",
  capture: true,
  run(command, args) {
    if (args[1] === "publish" && !args.includes("--dry-run=true")) {
      return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("synthetic upload timeout"), { code: "ETIMEDOUT" }) };
    }
    return successfulStage(args);
  },
  readPublished() {
    recoveredReads += 1;
    return recoveredReads === 1 ? null : publishedRecord();
  },
});
assert(recoveredPublication.recovered === true
  && recoveredPublication.recoveryWarning.includes("registry now exposes the exact accepted bytes"),
"ambiguous npm upload was not reconciled to the exact registry artifact");

await assertRejects(
  () => publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    npmCli: "/synthetic/hardened/npm-cli.js",
    run(command, args) {
      if (args[1] === "publish" && !args.includes("--dry-run=true")) {
        return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("synthetic upload timeout"), { code: "ETIMEDOUT" }) };
      }
      return successfulStage(args);
    },
    readPublished: () => null,
  }),
  "publication outcome is ambiguous",
);

const challengeId = "synthetic-private-cli-challenge-123456789";
let authError = null;
try {
  await publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    npmCli: "/synthetic/hardened/npm-cli.js",
    interactiveTty: false,
    run(command, args, options) {
      if (args[1] === "publish" && !args.includes("--dry-run=true")) {
        assert(options.stdio === "pipe", "non-TTY npm upload did not capture the authentication challenge");
        return {
          status: 1,
          stdout: "",
          stderr: `npm error code EOTP\nAuthenticate your account at https://www.npmjs.com/auth/cli/${challengeId}?state=synthetic-state`,
        };
      }
      return successfulStage(args);
    },
    readPublished: () => null,
  });
} catch (error) { authError = error; }
assert(authError?.code === "EOTP" && String(authError.message).includes("real owner TTY")
  && !String(authError.message).includes(challengeId) && !String(authError.message).includes("synthetic-state"),
"npm authentication failure was not converted into a privacy-safe actionable recovery result");

let mismatchCalls = 0;
await assertRejects(
  () => publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    npmCli: "/synthetic/hardened/npm-cli.js",
    run(command, args) { mismatchCalls += 1; return successfulStage(args); },
    readPublished: () => publishedRecord({ shasum: "f".repeat(40) }),
  }),
  "does not match the exact accepted candidate",
);
assert(mismatchCalls === 2, "npm upload was attempted after detecting an immutable registry mismatch");

const cleanupFailure = await publishCurrentNpmPackage(root, "prerelease", {
  ...acceptedOptions,
  capture: true,
  createSession: async () => ({
    cli: "/synthetic/hardened/npm-cli.js",
    dispose() { throw new Error("synthetic temporary cleanup failure"); },
  }),
  run(command, args) { return successfulStage(args); },
  readPublished: (() => {
    let reads = 0;
    return () => (++reads === 1 ? null : publishedRecord());
  })(),
});
assert(cleanupFailure.cleanupWarning.includes("synthetic temporary cleanup failure"),
  "successful npm publication was incorrectly converted into failure by temporary cleanup");
await assertRejects(
  () => publishCurrentNpmPackage(root, "prerelease", {
    ...acceptedOptions,
    createSession: async () => ({
      cli: "/synthetic/hardened/npm-cli.js",
      dispose() { throw new Error("synthetic temporary cleanup failure"); },
    }),
    run() { return { status: 1, stdout: "", stderr: "publish failed" }; },
  }),
  "npm publication failed and temporary cleanup was incomplete",
);

await testPublicationTimeoutTerminatesDescendants();

function successfulStage(args) {
  return args.includes("--dry-run=true")
    ? { status: 0, stdout: publishDryRunJson(), stderr: "" }
    : { status: 0, stdout: "ok", stderr: "" };
}

function publishedRecord(overrides = {}) {
  return {
    version: accepted.metadata.package_version,
    integrity: accepted.metadata.integrity,
    shasum: accepted.metadata.shasum,
    distTag: "beta",
    publishedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function publishDryRunJson(overrides = {}) {
  const record = {
    name: accepted.metadata.package_name,
    version: accepted.metadata.package_version,
    filename: accepted.metadata.filename,
    shasum: accepted.metadata.shasum,
    integrity: accepted.metadata.integrity,
    ...overrides,
  };
  return JSON.stringify({ [accepted.metadata.package_name]: record });
}

async function testPublicationTimeoutTerminatesDescendants() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mbm-publish-timeout-tree-"));
  const marker = join(fixtureRoot, "descendant-ran");
  const fixture = join(fixtureRoot, "fixture.mjs");
  const descendant = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "setTimeout(() => writeFileSync(process.argv[1], 'leaked'), 500);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.env.MBM_PUBLISH_TIMEOUT_MARKER], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  try {
    const result = await runNpmPublicationProcess(process.execPath, [fixture], {
      cwd: root,
      env: { ...process.env, MBM_PUBLISH_TIMEOUT_MARKER: marker },
      stdio: "pipe",
      timeout: 100,
      maxBuffer: 1024 * 1024,
    });
    assert(result.error?.code === "ETIMEDOUT" && result.signal === "SIGKILL",
      "publication process-tree timeout did not settle as an explicit hard deadline");
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 800); });
    assert(!existsSync(marker),
      "publication timeout returned while a resistant npm lifecycle descendant could still continue work");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

console.log("npm publication command test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
async function assertRejects(callback, expected) { try { await callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected rejection containing: ${expected}`); }
