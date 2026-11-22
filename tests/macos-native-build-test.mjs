import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("macOS native Swift tools compile with optimization", { skip: process.platform !== "darwin" }, () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const temp = mkdtempSync(path.join(tmpdir(), "mbm-macos-native-build-"));
  try {
    for (const [source, binary, extraFlags] of [
      ["native/macos/MachineBridgeBackgroundInput.swift", "background-input", ["-framework", "AppKit", "-framework", "CoreGraphics"]],
      ["tests/fixtures/native/MachineBridgeBackgroundInputSmokeFixture.swift", "smoke-fixture", ["-framework", "AppKit", "-framework", "CoreGraphics"]],
      ["native/macos/MachineBridgeTrustBroker.swift", "trust-broker", ["-parse-as-library", "-framework", "Security", "-framework", "LocalAuthentication"]],
    ]) {
      const result = spawnSync("/usr/bin/xcrun", [
        "swiftc", "-O", path.join(root, source), "-o", path.join(temp, binary),
        ...extraFlags,
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        killSignal: "SIGKILL",
        maxBuffer: 512 * 1024,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, `${source} swiftc launch failed: ${result.error?.message || "unknown error"}`);
      assert.equal(result.status, 0, `${source} failed to compile:\n${String(result.stderr || result.stdout).slice(0, 4000)}`);
      const built = statSync(path.join(temp, binary));
      assert(built.isFile() && built.size > 0, `${source} did not produce a native executable`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
