import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwnerOnlyDirectorySync } from "../src/local/secure-file.mjs";
import { cleanupStaleWorkerSecretFiles, withWorkerSecretsFile } from "../src/local/worker-secret-file.mjs";
import { createDeviceIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-worker-secrets-test-"));
try {
  const profileDir = join(root, "profile");
  await mkdir(profileDir, { mode: 0o777 });
  ensureOwnerOnlyDirectorySync(profileDir);
  if (process.platform !== "win32" && ((await stat(profileDir)).mode & 0o777) !== 0o700) {
    throw new Error("owner-only directory permissions were not enforced");
  }

  const target = join(root, "target");
  const link = join(root, "link");
  await mkdir(target);
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  expectThrow(() => ensureOwnerOnlyDirectorySync(link), "real directory");
  if (process.platform !== "win32") {
    expectThrow(() => ensureOwnerOnlyDirectorySync(join(root, "chmod-failure"), {
      platform: process.platform,
      fchmodSync() { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    }), "could not restrict");
  }
  ensureOwnerOnlyDirectorySync(join(root, "windows-chmod-unsupported"), {
    platform: "win32",
    fchmodSync() { throw new Error("must not be called"); },
  });

  const state = {
    paths: { profileDir },
    worker: {
      deviceIdentity: createDeviceIdentity(),
      oauthTokenVersion: "synthetic-token-version",
    },
  };
  let observedPath = "";
  const returned = await withWorkerSecretsFile(state, async (file) => {
    observedPath = file;
    const record = JSON.parse(await readFile(file, "utf8"));
    if (Object.hasOwn(record, "ACCOUNT_ADMIN_SECRET")) throw new Error("legacy account administration secret remained in the Worker deployment payload");
    if (record.DAEMON_DEVICE_PUBLIC_KEY !== publicDeviceJwkJson(state.worker.deviceIdentity)) throw new Error("device public key was not supplied to the Worker deployment");
    if (Object.hasOwn(record, "DAEMON_SHARED_SECRET")) throw new Error("legacy daemon bearer secret remained in the Worker deployment payload");
    if (process.platform !== "win32" && ((await stat(file)).mode & 0o777) !== 0o600) throw new Error("temporary secrets file mode is not 0600");
    if (!/-p\d+-[a-f0-9]{12}\.json$/.test(file)) throw new Error("temporary secrets filename omitted process-start identity or entropy");
    return "callback-result";
  });
  if (returned !== "callback-result") throw new Error("temporary secrets callback result was lost");
  if (await exists(observedPath)) throw new Error("temporary secrets file survived successful callback cleanup");

  let generationReads = 0;
  const generationResult = await withWorkerSecretsFile(state, async () => "generation-ok", {
    chmodFile() {},
    lstatSync() {
      generationReads += 1;
      return syntheticSecretStat(7n, 9n, generationReads === 1 ? 100n : 200n);
    },
  });
  if (generationResult !== "generation-ok" || generationReads !== 3) {
    throw new Error("Worker secret cleanup did not refresh identity after intentional chmod generation change");
  }

  let retryCallbackRan = false;
  const retryResult = await withWorkerSecretsFile(state, async () => { retryCallbackRan = true; return "retry-ok"; }, {
    exclusiveFileOptions: {
      unlink() { throw Object.assign(new Error("synthetic first staging unlink failure"), { code: "EPERM" }); },
    },
  });
  if (!retryCallbackRan || retryResult !== "retry-ok") throw new Error("Worker secret staging cleanup retry blocked a recovered safe callback");
  const hiddenAfterRetry = (await (await import("node:fs/promises")).readdir(profileDir)).filter((name) => name.startsWith(".worker-secrets-") && name.endsWith(".tmp"));
  if (hiddenAfterRetry.length !== 0) throw new Error("Worker secret staging cleanup retry left a hidden secret-bearing temp artifact");

  let blockedCallbackRan = false;
  await expectReject(() => withWorkerSecretsFile(state, async () => { blockedCallbackRan = true; return "must-not-run"; }, {
    exclusiveFileOptions: {
      unlink() { throw Object.assign(new Error("synthetic first staging unlink failure"), { code: "EPERM" }); },
    },
    removeFile() { throw Object.assign(new Error("synthetic retry cleanup failure"), { code: "EPERM" }); },
  }), "staging cleanup failed", AggregateError);
  if (blockedCallbackRan) throw new Error("Worker deployment callback ran after secret-bearing staging cleanup remained unverified");
  for (const name of readdirSync(profileDir)) {
    if (name.startsWith("worker-secrets-") || name.startsWith(".worker-secrets-")) {
      try { unlinkSync(join(profileDir, name)); } catch {}
    }
  }

  await expectReject(() => withWorkerSecretsFile(state, async () => "must-not-run", { now: () => 0 }), "timestamp is invalid");

  const stale = join(profileDir, "worker-secrets-999999-1000-p500-deadbeefcafe.json");
  await writeFile(stale, "{}", { mode: 0o600 });
  cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess() { return { current: false, reclaimable: true, reason: "not_running" }; },
  });
  if (await exists(stale)) throw new Error("reclaimable stale secrets file was not removed");

  const legacyStale = join(profileDir, "worker-secrets-999998-1001-deadbeefcafe.json");
  await writeFile(legacyStale, "{}", { mode: 0o600 });
  let legacyOwner;
  cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess(owner) { legacyOwner = owner; return { reclaimable: true }; },
  });
  if (legacyOwner?.processStartedAt !== undefined || await exists(legacyStale)) {
    throw new Error("legacy Worker-secret filename did not preserve optional process-start identity semantics");
  }

  cleanupStaleWorkerSecretFiles(profileDir, {
    readDirectory() { return [
      { name: "directory-entry", isFile: () => false },
      { name: "unrelated.txt", isFile: () => true },
      { name: "worker-secrets-1-2-p3-acde1234abcd.json", isFile: () => true },
    ]; },
    lstatSync() { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
  });

  expectThrow(() => cleanupStaleWorkerSecretFiles(profileDir, {
    readDirectory() { return [{ name: "worker-secrets-1-2-p3-acde1234abcd.json", isFile: () => true }]; },
    lstatSync() { return syntheticSecretStat(1n, 2n); },
    inspectProcess() { throw new Error("synthetic owner inspection failure"); },
  }), "could not inspect temporary Worker secrets owner");

  const ambiguous = join(profileDir, "worker-secrets-123-2000-p1000-acde1234abcd.json");
  await writeFile(ambiguous, "{}", { mode: 0o600 });
  cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess() { return { current: false, reclaimable: false, reason: "identity_unavailable" }; },
  });
  if (!await exists(ambiguous)) throw new Error("ambiguous live-owner secrets file was removed");
  await rm(ambiguous, { force: true });

  const undeletable = join(profileDir, "worker-secrets-321-3000-p2000-acde1234abcd.json");
  await writeFile(undeletable, "{}", { mode: 0o600 });
  expectThrow(() => cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess() { return { current: false, reclaimable: true, reason: "not_running" }; },
    removeFile() { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  }), "could not remove stale");
  await rm(undeletable, { force: true });

  const changedIdentity = join(profileDir, "worker-secrets-654-4000-p3000-acde1234abcd.json");
  await writeFile(changedIdentity, "{}", { mode: 0o600 });
  const actualIdentity = lstatSync(changedIdentity, { bigint: true });
  let identityReads = 0;
  const identityFailure = expectThrow(() => cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess() { return { reclaimable: true }; },
    lstatSync(_file) {
      identityReads += 1;
      if (identityReads === 1) return actualIdentity;
      return syntheticSecretStat(actualIdentity.dev, actualIdentity.ino + 1n);
    },
  }), "could not remove stale temporary Worker secrets file");
  if (!String(identityFailure?.cause?.message || "").includes("identity changed before cleanup")) {
    throw new Error("Worker-secret cleanup hid its internal identity-change cause");
  }
  if (!await exists(changedIdentity)) throw new Error("identity-changed Worker secret was removed");
  await rm(changedIdentity, { force: true });

  let setupFailurePath = "";
  await expectReject(() => withWorkerSecretsFile(state, async (file) => {
    setupFailurePath = file;
    throw new Error("callback must not run");
  }, {
    chmodFile(file) {
      setupFailurePath = file;
      throw Object.assign(new Error("chmod denied"), { code: "EPERM" });
    },
  }), "chmod denied");
  if (!setupFailurePath || await exists(setupFailurePath)) throw new Error("temporary secrets file survived setup failure cleanup");

  await expectReject(() => withWorkerSecretsFile(state, async () => "ok", {
    removeFile() { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  }), "could not remove temporary Worker secrets file");

  await expectReject(() => withWorkerSecretsFile(state, async () => { throw new Error("deployment failed"); }, {
    removeFile() { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  }), "cleanup also failed", AggregateError);

  console.log("Worker secrets lifecycle test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function syntheticSecretStat(dev, ino, ctimeNs) {
  return { dev, ino, ...(ctimeNs === undefined ? {} : { ctimeNs }), size: 2n, mtimeMs: 1n, isFile: () => true, isSymbolicLink: () => false };
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function expectThrow(callback, message) {
  try { callback(); } catch (error) {
    if (!String(error?.message || error).includes(message)) throw error;
    return error;
  }
  throw new Error(`expected failure containing: ${message}`);
}

async function expectReject(callback, message, ErrorType = Error) {
  try { await callback(); } catch (error) {
    if (!(error instanceof ErrorType) || !String(error.message).includes(message)) throw error;
    return;
  }
  throw new Error(`expected rejection containing: ${message}`);
}
