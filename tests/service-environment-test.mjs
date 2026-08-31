import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureServiceEnvironment,
  loadServiceEnvironment,
  serviceEnvironmentSummary,
  serviceEnvironmentPath,
  writeServiceEnvironment,
} from "../src/local/service-environment.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "mbm-service-environment-"));
try {
  mkdirSync(root, { recursive: true });
  const source = {
    MBM_RELAY_PROXY: "http://127.0.0.1:17891",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",
    SECRET_TOKEN: "must-not-be-persisted",
  };
  assert.deepEqual(captureServiceEnvironment(source), {
    MBM_RELAY_PROXY: source.MBM_RELAY_PROXY,
    HTTPS_PROXY: source.HTTPS_PROXY,
    NO_PROXY: source.NO_PROXY,
    NODE_USE_ENV_PROXY: source.NODE_USE_ENV_PROXY,
  });

  const written = writeServiceEnvironment(root, source);
  assert.equal(written.path, serviceEnvironmentPath(root));
  assert.deepEqual(written.keys, ["HTTPS_PROXY", "MBM_RELAY_PROXY", "NODE_USE_ENV_PROXY", "NO_PROXY"]);
  const disk = readFileSync(written.path, "utf8");
  assert.equal(disk.includes("SECRET_TOKEN"), false, "unapproved environment key was persisted");
  assert.equal(disk.includes("must-not-be-persisted"), false, "unapproved environment value was persisted");

  const target = { HTTPS_PROXY: "http://runtime.example.invalid:3128" };
  const loaded = loadServiceEnvironment(root, target);
  assert.equal(target.HTTPS_PROXY, "http://runtime.example.invalid:3128", "runtime environment was overwritten");
  assert.equal(target.MBM_RELAY_PROXY, source.MBM_RELAY_PROXY);
  assert.equal(target.NO_PROXY, source.NO_PROXY);
  assert.equal(target.NODE_USE_ENV_PROXY, source.NODE_USE_ENV_PROXY);
  assert.deepEqual(loaded.keys, ["MBM_RELAY_PROXY", "NODE_USE_ENV_PROXY", "NO_PROXY"]);
  assert.deepEqual(serviceEnvironmentSummary(root), {
    configured: true,
    keys: ["HTTPS_PROXY", "MBM_RELAY_PROXY", "NODE_USE_ENV_PROXY", "NO_PROXY"],
  });
  const storageFailure = {
    inspectPathIfPresentSync() {
      throw Object.assign(new Error("synthetic service environment storage failure"), { code: "EIO" });
    },
  };
  assert.throws(() => loadServiceEnvironment(root, {}, storageFailure), /synthetic service environment storage failure/);
  assert.throws(() => serviceEnvironmentSummary(root, storageFailure), /synthetic service environment storage failure/);
  assert.throws(() => writeServiceEnvironment(root, {}, storageFailure), /synthetic service environment storage failure/);

  writeServiceEnvironment(root, {});
  const preserved = {};
  loadServiceEnvironment(root, preserved);
  assert.equal(preserved.HTTPS_PROXY, source.HTTPS_PROXY, "an environment-free later startup erased the saved proxy");
  writeServiceEnvironment(root, { https_proxy: "http://replacement.example.invalid:8081" });
  const replaced = {};
  loadServiceEnvironment(root, replaced);
  assert.equal(replaced.HTTPS_PROXY, undefined, "case-insensitive proxy replacement retained the obsolete variant");
  assert.equal(replaced.https_proxy, "http://replacement.example.invalid:8081");

  const windowsTarget = { https_proxy: "http://windows-runtime.example.invalid:8080" };
  loadServiceEnvironment(root, windowsTarget, { platform: "win32" });
  assert.equal(windowsTarget.HTTPS_PROXY, undefined, "Windows case-insensitive environment key was duplicated");
  assert.equal(windowsTarget.https_proxy, "http://windows-runtime.example.invalid:8080");

  assert.throws(() => captureServiceEnvironment({ HTTP_PROXY: "bad\nvalue" }), /prohibited control character/);
  assert.throws(() => captureServiceEnvironment({ HTTP_PROXY: "x".repeat(20 * 1024) }), /size limit/);
  console.log("service environment persistence test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
