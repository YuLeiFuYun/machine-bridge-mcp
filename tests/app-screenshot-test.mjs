import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { AppAutomationManager } from "../src/local/app-automation.mjs";
import { BridgeError, publicError } from "../src/local/errors.mjs";

defaultVisualBackendIsDisabled();
await experimentalBackendRequiresSuccessfulProbe();
await experimentalProbeFailureKeepsScreenshotAvailable();
await capturesWindowPngWithoutActivatingApplication();
await inspectsWindowIdentityWithoutTakingAnotherScreenshot();
await capturePrefersAxFrontWindowOverLargerWindow();
await captureUsesAxTitleToDisambiguateEqualBounds();
await captureRejectsAmbiguousEqualBoundsBeforeScreenshot();
await captureRejectsMultipleWindowsWithoutAxBounds();
await pointActionCarriesSnapshotWindowBinding();
await doubleClickActionCarriesSnapshotWindowBinding();
await dragActionCarriesSnapshotWindowBinding();
await dragActionRejectsChangedScreenshotBeforeInput();
await dragActionCancellationAfterSnapshotSkipsInput();
await scrollActionCarriesSnapshotWindowBinding();
await scrollActionRejectsChangedScreenshotBeforeInput();
await scrollActionCancellationAfterSnapshotSkipsInput();
await pointActionRejectsChangedProcessBeforeInput();
await pointActionRejectsChangedScreenshotBeforeInput();
await pointActionCancellationAfterSnapshotSkipsInput();
await pointActionPreservesUnknownHelperSettlement();
await rejectsInvalidCaptureAndCleansTemporaryDirectory();

console.log("application screenshot test ok");

function defaultVisualBackendIsDisabled() {
  const manager = managerWith(async () => { throw new Error("disabled backend must not execute a local process"); });
  assert.deepEqual(manager.visualPointCapability(), {
    available: false, configured: false, probed: false, backend: "disabled", experimental: false,
    non_disruptive_intent: false, error_class: "",
  });
}

async function experimentalBackendRequiresSuccessfulProbe() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x51]);
  let probeCalls = 0;
  const service = {
    state: { probed: false, available: false, error: "" },
    status() {
      return { configured: true, probed: this.state.probed, available: this.state.available, backend: "skylight-experimental", error: this.state.error };
    },
    async probe() {
      probeCalls += 1;
      this.state = { probed: true, available: true, error: "" };
      return { ok: true, backend: "skylight-experimental" };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(777, { x: 1, y: 2, width: 300, height: 200 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  assert.deepEqual(manager.visualPointCapability(), {
    available: false, configured: true, probed: false, backend: "skylight-experimental", experimental: true,
    non_disruptive_intent: true, error_class: "",
  });
  const capture = await manager.captureApplication({ application: "Notes", timeout_seconds: 2 });
  assert.equal(probeCalls, 1);
  assert.equal(capture.background_visual_point.available, true);
  assert.equal(capture.background_visual_point.probed, true);
  assert.equal(manager.visualPointCapability().available, true);
}

async function experimentalProbeFailureKeepsScreenshotAvailable() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x52]);
  const service = {
    state: { probed: false, available: false, error: "" },
    status() {
      return { configured: true, probed: this.state.probed, available: this.state.available, backend: "skylight-experimental", error: this.state.error };
    },
    async probe() {
      this.state = { probed: true, available: false, error: "helper_probe_failed_before_dispatch" };
      return { ok: false, backend: "skylight-experimental", error: this.state.error };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(778, { x: 4, y: 5, width: 320, height: 210 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const capture = await manager.captureApplication({ application: "Notes", timeout_seconds: 2 });
  assert.equal(capture.screenshot.mime_type, "image/png", "visual backend probe failure discarded the application screenshot");
  assert.equal(capture.background_visual_point.available, false);
  assert.equal(capture.background_visual_point.probed, true);
  assert.equal(capture.background_visual_point.error_class, "helper_probe_failed_before_dispatch");
}

async function capturesWindowPngWithoutActivatingApplication() {
  const calls = [];
  let outputPath = "";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42, 0x43]);
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }, "Fixture"))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      outputPath = argv.at(-1);
      await writeFile(outputPath, png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const result = await manager.captureApplication({ application: "Notes", timeout_seconds: 2 });
  assert.equal(result.screenshot.mime_type, "image/png");
  assert.equal(result.screenshot.source, "macos_window");
  assert.equal(Buffer.from(result.screenshot.data, "base64").equals(png), true);
  assert.deepEqual(result.screenshot.bounds, { x: 10, y: 20, width: 640, height: 480 });
  assert.deepEqual(result.window, { id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 } });
  assert.equal(result._machine_process_id, 987, "window capture did not retain its private process identity");
  assert.equal(result.screen_recording_permission_required, true);
  assert.equal(calls.find((entry) => entry.cmd === "/usr/sbin/screencapture").argv.includes("-o"), true, "window screenshot retained an unmodeled drop shadow");
  assert.deepEqual(calls.map((entry) => entry.cmd), ["osascript", "/usr/sbin/screencapture"]);
  assert.equal(calls.some((entry) => entry.cmd === "open"), false, "window capture activated the application");
  await assert.rejects(() => stat(outputPath), (error) => error?.code === "ENOENT");
}

async function inspectsWindowIdentityWithoutTakingAnotherScreenshot() {
  const calls = [];
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(432, { x: 30, y: 40, width: 500, height: 360 }, "Identity"))}\n`, stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const result = await manager.inspectApplicationWindow({ application: "Notes", timeout_seconds: 2 });
  assert.deepEqual(result.window, { id: 432, bounds: { x: 30, y: 40, width: 500, height: 360 } });
  assert.equal(result.process_name, "Notes");
  assert.deepEqual(calls.map((entry) => entry.cmd), ["osascript"]);
  assert.equal(calls.some((entry) => entry.cmd === "/usr/sbin/screencapture"), false, "window identity recheck unexpectedly took another screenshot");
}

async function capturePrefersAxFrontWindowOverLargerWindow() {
  const calls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44]);
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify({
        process_id: 987,
        process_generation: "gen-987",
        front_bounds: { x: 300, y: 220, width: 420, height: 260 },
        candidates: [
          { window_id: 100, bounds: { x: 20, y: 20, width: 1200, height: 800 }, title: "Main" },
          { window_id: 200, bounds: { x: 300, y: 220, width: 420, height: 260 }, title: "Dialog" },
        ],
      })}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const result = await manager.captureApplication({ application: "Notes", timeout_seconds: 2 });
  assert.equal(result.window.id, 200, "application screenshot selected the larger background window instead of the AX front window");
  const capture = calls.find((entry) => entry.cmd === "/usr/sbin/screencapture");
  assert.deepEqual(capture.argv.slice(0, 4), ["-x", "-o", "-l", "200"]);
}

async function captureUsesAxTitleToDisambiguateEqualBounds() {
  const calls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x45]);
  const bounds = { x: 50, y: 60, width: 500, height: 340 };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify({
        process_id: 987,
        process_generation: "gen-987",
        front_bounds: bounds,
        front_title: "Front Dialog",
        candidates: [
          { window_id: 301, bounds, title: "Background Clone" },
          { window_id: 302, bounds, title: "Front Dialog" },
        ],
      })}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const result = await manager.captureApplication({ application: "Notes", timeout_seconds: 2 });
  assert.equal(result.window.id, 302, "equal-bounds windows were not disambiguated by the AX front-window title");
  assert.equal(calls.find((entry) => entry.cmd === "/usr/sbin/screencapture").argv.includes("302"), true);
}

async function captureRejectsAmbiguousEqualBoundsBeforeScreenshot() {
  const calls = [];
  const bounds = { x: 50, y: 60, width: 500, height: 340 };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify({
        process_id: 987,
        process_generation: "gen-987",
        front_bounds: bounds,
        front_title: "",
        candidates: [
          { window_id: 401, bounds, title: "One" },
          { window_id: 402, bounds, title: "Two" },
        ],
      })}\n`, stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  await assert.rejects(
    () => manager.captureApplication({ application: "Notes", timeout_seconds: 2 }),
    /front window is ambiguous among matching on-screen windows/,
  );
  assert.equal(calls.some((entry) => entry.cmd === "/usr/sbin/screencapture"), false, "ambiguous same-bounds windows reached screenshot capture");
}

async function captureRejectsMultipleWindowsWithoutAxBounds() {
  const calls = [];
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify({
        process_id: 987,
        process_generation: "gen-987",
        front_bounds: null,
        front_title: "",
        candidates: [
          { window_id: 501, bounds: { x: 10, y: 10, width: 300, height: 200 }, title: "One" },
          { window_id: 502, bounds: { x: 400, y: 10, width: 300, height: 200 }, title: "Two" },
        ],
      })}\n`, stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  await assert.rejects(
    () => manager.captureApplication({ application: "Notes", timeout_seconds: 2 }),
    /front window is ambiguous without Accessibility bounds/,
  );
  assert.equal(calls.some((entry) => entry.cmd === "/usr/sbin/screencapture"), false, "multiple windows without AX front bounds reached screenshot capture");
}

async function pointActionCarriesSnapshotWindowBinding() {
  const calls = [];
  const serviceCalls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42, 0x43]);
  const digest = createHash("sha256").update(png).digest("hex");
  const service = {
    async click(args) {
      serviceCalls.push(args);
      return { ok: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "window_candidates") {
        return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }, "Fixture"))}\n`, stderr: "" };
      }
      throw new Error(`unexpected JXA operation ${payload.operation}`);
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const result = await manager.pointApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.75, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  });
  assert.deepEqual(calls.map((entry) => entry.cmd), ["osascript", "/usr/sbin/screencapture"]);
  assert.equal(serviceCalls.length, 1);
  assert.deepEqual(serviceCalls[0], {
    pid: 987, process_generation: "gen-987", window_id: 321, screen_x: 170, screen_y: 380, local_x: 160, local_y: 360,
    window_x: 10, window_y: 20, window_width: 640, window_height: 480, timeout_seconds: 2,
  });
  assert.equal(result.coordinate_source, "macos_skylight_experimental");
  assert.equal(result.window_bound, true);
  assert.equal(result.screenshot_revalidated, true);
  assert.equal(result.focus_without_raise, true);
  assert.equal(result.front_window_validated, true);
  assert.equal(result.cursor_preserved, true);
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: [0.25], normalized_y: 0.75, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  }), /normalized_x must be from 0/);
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.75, window_id: 321,
    bounds: { x: [10], y: 20, width: 640, height: 480 }, screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  }), /bounds.x must be finite/);
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.75, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: [digest], expected_process_id: 987, timeout_seconds: 2,
  }), /screenshot_sha256 must be a SHA-256 hex digest/);
  assert.equal(serviceCalls.length, 1, "coercible visual point authority reached background input");
}

async function doubleClickActionCarriesSnapshotWindowBinding() {
  const serviceCalls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x42, 0x4c]);
  const digest = createHash("sha256").update(png).digest("hex");
  const service = {
    async click(args) {
      serviceCalls.push(args);
      return { ok: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "window_candidates") {
        return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }, "Fixture"))}\n`, stderr: "" };
      }
      throw new Error(`unexpected JXA operation ${payload.operation}`);
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const result = await manager.pointApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.75, click_count: 2, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  });
  assert.deepEqual(serviceCalls, [{
    pid: 987, process_generation: "gen-987", window_id: 321, screen_x: 170, screen_y: 380, local_x: 160, local_y: 360, click_count: 2,
    window_x: 10, window_y: 20, window_width: 640, window_height: 480, timeout_seconds: 2,
  }]);
  assert.equal(result.coordinate_source, "macos_skylight_experimental");
  assert.equal(result.screenshot_revalidated, true);
  assert.equal(result.cursor_preserved, true);
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.75, click_count: 3, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /click_count must be 1 or 2/);
  assert.equal(serviceCalls.length, 1, "invalid click count reached background input");
}

async function dragActionCarriesSnapshotWindowBinding() {
  const calls = [];
  const serviceCalls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x52, 0x41, 0x47]);
  const digest = createHash("sha256").update(png).digest("hex");
  const service = {
    async drag(args) {
      serviceCalls.push(args);
      return { ok: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: true };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "window_candidates") {
        return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }, "Fixture"))}\n`, stderr: "" };
      }
      throw new Error(`unexpected JXA operation ${payload.operation}`);
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const result = await manager.dragApplication({
    application: "Notes", normalized_x: 0.25, normalized_y: 0.25,
    destination_normalized_x: 0.75, destination_normalized_y: 0.5,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 },
    screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  });
  assert.deepEqual(calls.map((entry) => entry.cmd), ["osascript", "/usr/sbin/screencapture"]);
  assert.equal(serviceCalls.length, 1);
  assert.deepEqual(serviceCalls[0], {
    pid: 987, process_generation: "gen-987", window_id: 321,
    screen_x: 170, screen_y: 140, local_x: 160, local_y: 120,
    destination_screen_x: 490, destination_screen_y: 260,
    destination_local_x: 480, destination_local_y: 240,
    window_x: 10, window_y: 20, window_width: 640, window_height: 480, timeout_seconds: 2,
  });
  assert.equal(result.coordinate_source, "macos_skylight_experimental");
  assert.equal(result.screenshot_revalidated, true);
  assert.equal(result.cursor_preserved, true);
  assert.equal(result.frontmost_restored, true);
  assert.deepEqual(result.normalized_point, { x: 0.25, y: 0.25 });
  assert.deepEqual(result.destination_normalized_point, { x: 0.75, y: 0.5 });
}

async function dragActionRejectsChangedScreenshotBeforeInput() {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x52]);
  const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x58]);
  const digest = createHash("sha256").update(original).digest("hex");
  let serviceDrags = 0;
  const service = { async drag() { serviceDrags += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), changed);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  await assert.rejects(() => manager.dragApplication({
    application: "Notes", normalized_x: 0.2, normalized_y: 0.3,
    destination_normalized_x: 0.8, destination_normalized_y: 0.7,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application visual snapshot changed before dispatch/);
  assert.equal(serviceDrags, 0, "changed application screenshot reached native drag input");
}

async function dragActionCancellationAfterSnapshotSkipsInput() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x43]);
  const digest = createHash("sha256").update(png).digest("hex");
  let cancelled = false;
  let serviceDrags = 0;
  const service = { async drag() { serviceDrags += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      cancelled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, {
    backgroundInputService: service,
    throwIfCancelled() { if (cancelled) throw new Error("application drag request cancelled"); },
  });
  await assert.rejects(() => manager.dragApplication({
    application: "Notes", normalized_x: 0.2, normalized_y: 0.3,
    destination_normalized_x: 0.8, destination_normalized_y: 0.7,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application drag request cancelled/);
  assert.equal(serviceDrags, 0, "application drag started after cancellation arrived during screenshot revalidation");
}

async function scrollActionCarriesSnapshotWindowBinding() {
  const calls = [];
  const serviceCalls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x43, 0x52, 0x4c]);
  const digest = createHash("sha256").update(png).digest("hex");
  const service = {
    async scroll(args) {
      serviceCalls.push(args);
      return { ok: true, focus_without_raise: true, front_window_validated: true, cursor_preserved: true, frontmost_restored: false };
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv] });
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "window_candidates") {
        return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }, "Fixture"))}\n`, stderr: "" };
      }
      throw new Error(`unexpected JXA operation ${payload.operation}`);
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const result = await manager.scrollApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.25,
    delta_x: -120.4, delta_y: 480.6,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 },
    screenshot_sha256: digest, expected_process_id: 987, timeout_seconds: 2,
  });
  assert.deepEqual(calls.map((entry) => entry.cmd), ["osascript", "/usr/sbin/screencapture"]);
  assert.equal(serviceCalls.length, 1);
  assert.deepEqual(serviceCalls[0], {
    pid: 987, process_generation: "gen-987", window_id: 321,
    screen_x: 330, screen_y: 140, local_x: 320, local_y: 120,
    delta_x: -120, delta_y: 481,
    window_x: 10, window_y: 20, window_width: 640, window_height: 480, timeout_seconds: 2,
  });
  assert.equal(result.coordinate_source, "macos_skylight_experimental");
  assert.equal(result.screenshot_revalidated, true);
  assert.equal(result.cursor_preserved, true);
  assert.deepEqual(result.normalized_point, { x: 0.5, y: 0.25 });
  assert.deepEqual(result.scroll_delta, { delta_x: -120, delta_y: 481 });
}

async function scrollActionRejectsChangedScreenshotBeforeInput() {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x43]);
  const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x58]);
  const digest = createHash("sha256").update(original).digest("hex");
  let serviceScrolls = 0;
  const service = { async scroll() { serviceScrolls += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), changed);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  await assert.rejects(() => manager.scrollApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, delta_y: 500,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application visual snapshot changed before dispatch/);
  assert.equal(serviceScrolls, 0, "changed application screenshot reached native scroll input");
}

async function scrollActionCancellationAfterSnapshotSkipsInput() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x43, 0x43]);
  const digest = createHash("sha256").update(png).digest("hex");
  let cancelled = false;
  let serviceScrolls = 0;
  const service = { async scroll() { serviceScrolls += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      cancelled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, {
    backgroundInputService: service,
    throwIfCancelled() { if (cancelled) throw new Error("application scroll request cancelled"); },
  });
  await assert.rejects(() => manager.scrollApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, delta_y: 500,
    window_id: 321, bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application scroll request cancelled/);
  assert.equal(serviceScrolls, 0, "application scroll started after cancellation arrived during screenshot revalidation");
}

async function pointActionRejectsChangedProcessBeforeInput() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]);
  const digest = createHash("sha256").update(png).digest("hex");
  let screenshotCalls = 0;
  let serviceClicks = 0;
  const service = { async click() { serviceClicks += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      assert.equal(payload.expectedProcessId, 123, "snapshot pid was not forwarded to window selection");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      screenshotCalls += 1;
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, expected_process_id: 123, timeout_seconds: 2,
  }), /application process changed before operation/);
  assert.equal(screenshotCalls, 0, "changed application process reached screenshot recapture");
  assert.equal(serviceClicks, 0, "changed application process reached native visual input");
}

async function pointActionRejectsChangedScreenshotBeforeInput() {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]);
  const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);
  const digest = createHash("sha256").update(original).digest("hex");
  let serviceClicks = 0;
  const service = { async click() { serviceClicks += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      if (payload.operation === "window_candidates") {
        return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
      }
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), changed);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application visual snapshot changed before dispatch/);
  assert.equal(serviceClicks, 0, "changed screenshot reached the experimental background-input service");
}

async function pointActionCancellationAfterSnapshotSkipsInput() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42]);
  const digest = createHash("sha256").update(png).digest("hex");
  let cancelled = false;
  let serviceClicks = 0;
  const service = { async click() { serviceClicks += 1; return { ok: true }; } };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      cancelled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, {
    backgroundInputService: service,
    throwIfCancelled() { if (cancelled) throw new Error("application request cancelled"); },
  });
  await assert.rejects(() => manager.pointApplication({
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  }), /application request cancelled/);
  assert.equal(serviceClicks, 0,
    "application visual point input started after cancellation arrived during screenshot revalidation");
}

async function pointActionPreservesUnknownHelperSettlement() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x43]);
  const digest = createHash("sha256").update(png).digest("hex");
  let serviceMode = "cancelled";
  const service = {
    async click() {
      if (serviceMode === "cancelled") throw new BridgeError("cancelled", "helper launch cancelled before dispatch");
      throw new Error("macOS SkyLight background input may have been partially dispatched; the action outcome is unknown (helper unavailable after invocation)");
    },
  };
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(321, { x: 10, y: 20, width: 640, height: 480 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      await writeFile(argv.at(-1), png);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  }, { backgroundInputService: service });
  const pointArgs = {
    application: "Notes", normalized_x: 0.5, normalized_y: 0.5, window_id: 321,
    bounds: { x: 10, y: 20, width: 640, height: 480 }, screenshot_sha256: digest, timeout_seconds: 2,
  };
  await assert.rejects(() => manager.pointApplication(pointArgs),
    (error) => error instanceof BridgeError && error.code === "cancelled",
    "pre-spawn visual helper cancellation was incorrectly promoted to an unknown input mutation");
  serviceMode = "unknown";
  await assert.rejects(() => manager.pointApplication(pointArgs), (error) => {
    const message = String(error?.message || error);
    assert.match(message, /application visual input may have been partially dispatched.*outcome is unknown/i);
    assert.doesNotMatch(message, /unavailable before dispatch/i,
      "post-invocation visual uncertainty was downgraded because a private detail contained unavailable");
    assert.match(publicError(error).message, /application visual input may have been partially dispatched.*outcome is unknown/i,
      "ambiguous visual application input was hidden by the direct MCP error boundary");
    assert.equal(publicError(error).retryable, false, "ambiguous visual application input was advertised as retryable");
    return true;
  });
}

async function rejectsInvalidCaptureAndCleansTemporaryDirectory() {
  let outputPath = "";
  const manager = managerWith(async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "osascript") {
      const payload = JSON.parse(stdin);
      assert.equal(payload.operation, "window_candidates");
      return { code: 0, stdout: `${JSON.stringify(windowState(654, { x: 0, y: 0, width: 300, height: 200 }))}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/screencapture") {
      outputPath = argv.at(-1);
      await writeFile(outputPath, Buffer.from("not-a-png"));
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  await assert.rejects(() => manager.captureApplication({ application: "Notes" }), /not a PNG image/);
  await assert.rejects(() => stat(outputPath), (error) => error?.code === "ENOENT");
}

function windowState(windowId, bounds, title = "", processId = 987, processGeneration = `gen-${processId}`) {
  return {
    process_id: processId,
    process_generation: processGeneration,
    front_bounds: { ...bounds },
    candidates: [{ window_id: windowId, bounds: { ...bounds }, title }],
  };
}

function managerWith(runProcess, { backgroundInputService = null, throwIfCancelled = () => {} } = {}) {
  return new AppAutomationManager({
    policy: {},
    authorizeTool() {},
    displayPath: (value) => String(value),
    runProcess,
    readResourceText: async () => "",
    throwIfCancelled,
    platform: "darwin",
    home: "/tmp",
    backgroundVisualBackend: backgroundInputService ? "skylight-experimental" : "disabled",
    backgroundInputService,
  });
}
