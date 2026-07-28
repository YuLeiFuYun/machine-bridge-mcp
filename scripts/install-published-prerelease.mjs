#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateRoot, expandHome } from "../src/local/state.mjs";
import { writePrereleaseActivation } from "./prerelease-activation.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import { readPublishedNpmPrerelease } from "./published-release.mjs";
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { assertSoakEligiblePrerelease } from "./release-channel.mjs";
import { persistentActivationSpawnOptions } from "./persistent-activation-process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
let previousInstallation = null;
let installedPrerelease = "";
if (!npmCli) fail("published prerelease installation must run through npm");

try {
  if (!process.argv.includes("--allow-worker-deploy")) {
    throw new Error("published prerelease activation updates the global package, same-name Worker, and login daemon; rerun with --allow-worker-deploy");
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const requested = argumentValue("--version") || pkg.version;
  const prerelease = assertSoakEligiblePrerelease(requested);
  if (pkg.version !== prerelease.raw) {
    throw new Error(`source checkout version ${pkg.version} does not match requested prerelease ${prerelease.raw}`);
  }
  const acceptance = verifyCurrentReleaseAcceptance(root);
  if (!acceptance.required || acceptance.metadata.package_version !== prerelease.raw) {
    throw new Error("published prerelease installation requires the locally accepted exact prerelease source");
  }
  const promotionDigest = computePromotionContentDigest(root);
  if (acceptance.record.promotion_content_sha256 !== promotionDigest) {
    throw new Error("current source promotion digest does not match local candidate acceptance");
  }
  const published = readPublishedNpmPrerelease(pkg.name, prerelease.raw, prerelease.npmTag);
  if (published.integrity !== acceptance.metadata.integrity || published.shasum !== acceptance.metadata.shasum) {
    throw new Error("npm prerelease bytes do not match the locally accepted candidate");
  }

  previousInstallation = currentGlobalInstallation(pkg.name);
  runNpm([
    "install", "--global", "--omit=optional",
    "--allow-scripts=esbuild,workerd,sharp,fsevents",
    `${pkg.name}@${prerelease.raw}`,
  ]);
  const installed = currentGlobalInstallation(pkg.name);
  if (!installed || installed.version !== prerelease.raw) {
    throw new Error(`global prerelease installation did not converge on ${prerelease.raw}`);
  }
  installedPrerelease = prerelease.raw;

  const stateRoot = resolve(expandHome(argumentValue("--state-dir") || defaultStateRoot()));
  const forwarded = forwardedActivationArgs();
  const activation = runActivation(installed.entry, ["activate", ...forwarded, "--state-dir", stateRoot, "--json"]);
  if (activation.version !== prerelease.raw || activation.daemon?.version !== prerelease.raw || activation.worker?.health?.version !== prerelease.raw) {
    throw new Error("published prerelease activation did not converge on the exact registry version");
  }
  const recordPath = writePrereleaseActivation({
    schema_version: 1,
    package_name: pkg.name,
    package_version: prerelease.raw,
    source: "npm-prerelease",
    shasum: published.shasum,
    integrity: published.integrity,
    promotion_content_sha256: promotionDigest,
    activated_at: new Date().toISOString(),
    published_at: published.publishedAt,
    npm_dist_tag: prerelease.npmTag,
    workspace_hash: workspaceHash(activation.workspace),
    runtime_entry: installed.entry,
    ...(previousInstallation ? { previous: previousInstallation } : {}),
  }, stateRoot);

  console.log(`Published prerelease activated: ${prerelease.raw}`);
  console.log(`Worker and login daemon version: ${activation.version}`);
  console.log(`Soak activation record: ${recordPath}`);
  console.log("Use this prerelease normally. Any blocking issue requires a new beta/rc version and restarts the soak clock.");
} catch (error) {
  const message = boundedDiagnostic(error?.message || error);
  if (installedPrerelease) {
    const previousVersion = previousInstallation?.version || "unknown";
    fail(`${message}. The global package is now ${installedPrerelease}, but Worker/service activation may not have converged. Previous global version: ${previousVersion}. Preserve state and logs; fix forward with the exact prerelease or restore package, Worker, service definition, browser extension, and state as one verified unit.`);
  }
  fail(message);
}

function currentGlobalInstallation(packageName) {
  try {
    const globalRoot = runNpm(["root", "--global"]).stdout.trim();
    const packageRoot = join(globalRoot, packageName);
    const packagePath = join(packageRoot, "package.json");
    const entry = join(packageRoot, "bin", "machine-mcp.mjs");
    if (!existsSync(packagePath) || !existsSync(entry)) return null;
    const value = JSON.parse(readFileSync(packagePath, "utf8"));
    return { version: String(value.version || ""), entry };
  } catch {
    return null;
  }
}

function runActivation(entry, args) {
  const result = spawnSync(
    process.execPath,
    [entry, ...args],
    persistentActivationSpawnOptions({ cwd: root, env: process.env }),
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prerelease runtime activation failed: ${boundedDiagnostic(result.stderr || result.stdout)}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error("prerelease runtime activation did not return valid JSON"); }
}

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${boundedDiagnostic(result.stderr || result.stdout)}`);
  return result;
}

function forwardedActivationArgs() {
  const out = [];
  const skipWithValue = new Set(["--version", "--state-dir"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--allow-worker-deploy") continue;
    if (skipWithValue.has(value)) { index += 1; continue; }
    if (["--version=", "--state-dir="].some((prefix) => value.startsWith(prefix))) continue;
    if (value === "--json" || value.startsWith("--json=")) continue;
    out.push(value);
  }
  return out;
}

function argumentValue(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function workspaceHash(workspace) {
  const value = process.platform === "win32" ? String(workspace).toLowerCase() : String(workspace);
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function boundedDiagnostic(value) {
  const home = String(process.env.HOME || process.env.USERPROFILE || "");
  let text = String(value || "unknown error").replace(/[\r\n\t]+/g, " ").trim();
  if (home) text = text.split(home).join("<home>");
  return text.slice(0, 1600);
}

function fail(message) {
  console.error(`published prerelease installation failed: ${message}`);
  process.exit(1);
}
