import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createExclusiveFileSync } from "./exclusive-file.mjs";
import { currentProcessStartTimeMs, inspectProcessInstance } from "./process-identity.mjs";
import { publicDeviceJwkJson } from "./device-identity.mjs";
import { chmodRegularFileSync, ensureOwnerOnlyDirectorySync } from "./secure-file.mjs";

const SECRET_FILE_PATTERN = /^worker-secrets-(\d+)-(\d+)(?:-p(\d+))?(?:-([a-f0-9]+))?\.json$/;

export async function withWorkerSecretsFile(state, callback, options = {}) {
  const dir = state.paths.profileDir;
  ensureOwnerOnlyDirectorySync(dir, options.directoryOptions);
  cleanupStaleWorkerSecretFiles(dir, options);
  const createdAt = integerTimestamp(options.now?.() ?? Date.now());
  const processStartedAt = integerTimestamp(options.processStartedAtMs ?? currentProcessStartTimeMs());
  const random = (options.randomBytes || randomBytes)(6).toString("hex");
  const tempPath = resolve(dir, `worker-secrets-${process.pid}-${createdAt}-p${processStartedAt}-${random}.json`);
  const payload = {
    ACCOUNT_ADMIN_SECRET: state.worker.accountAdminSecret,
    DAEMON_DEVICE_PUBLIC_KEY: publicDeviceJwkJson(state.worker.deviceIdentity),
    OAUTH_TOKEN_VERSION: state.worker.oauthTokenVersion,
  };

  let created = false;
  let createdIdentity = null;
  let result;
  let primaryError;
  try {
    createExclusiveFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
    created = true;
    createdIdentity = fileIdentity((options.lstatSync || lstatSync)(tempPath));
    (options.chmodFile || chmodRegularFileSync)(tempPath, 0o600, "temporary Worker secrets file");
    result = await callback(tempPath);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  if (created) {
    try {
      removeFile(tempPath, options.removeFile || unlinkSync, "could not remove temporary Worker secrets file", createdIdentity, options.lstatSync || lstatSync);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (primaryError && cleanupError) {
    const message = primaryError instanceof Error && primaryError.message
      ? primaryError.message
      : "Worker deployment failed";
    throw new AggregateError(
      [primaryError, cleanupError],
      `${message}; temporary Worker secrets cleanup also failed`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function cleanupStaleWorkerSecretFiles(dir, options = {}) {
  const inspect = options.inspectProcess || inspectProcessInstance;
  const remove = options.removeFile || unlinkSync;
  const readDirectory = options.readDirectory || readdirSync;
  const inspectPath = options.lstatSync || lstatSync;
  for (const entry of readDirectory(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = SECRET_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const file = resolve(dir, entry.name);
    let snapshot;
    try {
      const info = inspectPath(file);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      snapshot = fileIdentity(info);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`could not inspect temporary Worker secrets file: ${entry.name}`, { cause: error });
    }
    const pid = Number(match[1]);
    const createdAt = Number(match[2]);
    const processStartedAt = match[3] ? Number(match[3]) : null;
    let identity;
    try {
      identity = inspect({
        pid,
        startedAt: new Date(createdAt).toISOString(),
        processStartedAt: processStartedAt ? new Date(processStartedAt).toISOString() : undefined,
      });
    } catch (error) {
      throw new Error(`could not inspect temporary Worker secrets owner: ${entry.name}`, { cause: error });
    }
    if (!identity?.reclaimable) continue;
    removeFile(file, remove, `could not remove stale temporary Worker secrets file: ${entry.name}`, snapshot, inspectPath);
  }
}

function removeFile(file, remove, message = "could not remove temporary Worker secrets file", expectedIdentity = null, inspectPath = lstatSync) {
  try {
    if (expectedIdentity) {
      const current = inspectPath(file);
      if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(expectedIdentity, fileIdentity(current))) {
        throw new Error("temporary Worker secrets file identity changed before cleanup");
      }
    }
    remove(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(message, { cause: error });
  }
}

function fileIdentity(info) {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function integerTimestamp(value) {
  const timestamp = Math.floor(Number(value));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("temporary Worker secrets timestamp is invalid");
  return timestamp;
}
