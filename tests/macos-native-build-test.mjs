import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("macOS native build test skipped on non-macOS");
  process.exit(0);
}

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(path.join(tmpdir(), "mbm-macos-native-build-"));
try {
  for (const [source, binary] of [
    ["native/macos/MachineBridgeBackgroundInput.swift", "background-input"],
    ["native/macos/MachineBridgeBackgroundInputSmokeFixture.swift", "smoke-fixture"],
  ]) {
    const result = spawnSync("/usr/bin/xcrun", [
      "swiftc", "-O", path.join(root, source), "-o", path.join(temp, binary),
      "-framework", "AppKit", "-framework", "CoreGraphics",
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
  console.log("macOS native helper build test ok");
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
