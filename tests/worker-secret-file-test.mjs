import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwnerOnlyDirectorySync } from "../src/local/secure-file.mjs";
import { cleanupStaleWorkerSecretFiles, withWorkerSecretsFile } from "../src/local/worker-secret-file.mjs";

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
      accountAdminSecret: "synthetic-account-secret",
      daemonSecret: "synthetic-daemon-secret",
      oauthTokenVersion: "synthetic-token-version",
    },
  };
  let observedPath = "";
  const returned = await withWorkerSecretsFile(state, async (file) => {
    observedPath = file;
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.ACCOUNT_ADMIN_SECRET !== state.worker.accountAdminSecret) throw new Error("temporary secrets payload is incomplete");
    if (process.platform !== "win32" && ((await stat(file)).mode & 0o777) !== 0o600) throw new Error("temporary secrets file mode is not 0600");
    if (!/-p\d+-[a-f0-9]{12}\.json$/.test(file)) throw new Error("temporary secrets filename omitted process-start identity or entropy");
    return "callback-result";
  });
  if (returned !== "callback-result") throw new Error("temporary secrets callback result was lost");
  if (await exists(observedPath)) throw new Error("temporary secrets file survived successful callback cleanup");

  const stale = join(profileDir, "worker-secrets-999999-1000-p500-deadbeefcafe.json");
  await writeFile(stale, "{}", { mode: 0o600 });
  cleanupStaleWorkerSecretFiles(profileDir, {
    inspectProcess() { return { current: false, reclaimable: true, reason: "not_running" }; },
  });
  if (await exists(stale)) throw new Error("reclaimable stale secrets file was not removed");

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

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function expectThrow(callback, message) {
  try { callback(); } catch (error) {
    if (!String(error?.message || error).includes(message)) throw error;
    return;
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
