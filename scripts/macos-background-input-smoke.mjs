#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppAutomationManager } from "../src/local/app-automation.mjs";
import { ComputerUseManager } from "../src/local/computer-use.mjs";
import { MacosBackgroundInputService } from "../src/local/macos-background-input.mjs";
import { packageRoot } from "../src/local/package-identity.mjs";

const EXPLICIT_FLAG = "--run";
const BACKEND_ENV = "MBM_MACOS_BACKGROUND_VISUAL_BACKEND";
const BACKEND_VALUE = "skylight-experimental";
const FIXTURE_SOURCE = path.join(packageRoot, "native", "macos", "MachineBridgeBackgroundInputSmokeFixture.swift");

if (process.platform !== "darwin") throw new Error("macOS background-input smoke requires macOS");
if (!process.argv.includes(EXPLICIT_FLAG)) {
  throw new Error(`refusing interactive smoke without ${EXPLICIT_FLAG}`);
}
if (process.env[BACKEND_ENV] !== BACKEND_VALUE) {
  throw new Error(`refusing interactive smoke unless ${BACKEND_ENV}=${BACKEND_VALUE}`);
}

const root = await mkdtemp(path.join(tmpdir(), "mbm-background-input-smoke-"));
const fixtureName = `mbmcu-${process.pid}`;
const fixtureApp = path.join(root, `${fixtureName}.app`);
const fixtureContents = path.join(fixtureApp, "Contents");
const fixtureBinary = path.join(fixtureContents, "MacOS", fixtureName);
const statusPath = path.join(root, "status.json");
const hitPath = path.join(root, "hit.json");
const dragPath = path.join(root, "drag.json");
const scrollPath = path.join(root, "scroll.json");
const activationPath = path.join(root, "activation.json");
let fixturePid = null;
let fixtureActivationBaseline = 0;
let frontBefore = null;
let frontAfter = null;

try {
  await mkdir(path.dirname(fixtureBinary), { recursive: true });
  await writeFile(path.join(fixtureContents, "Info.plist"), fixtureInfoPlist(fixtureName), "utf8");
  await runProcess("/usr/bin/xcrun", [
    "swiftc", "-O", FIXTURE_SOURCE, "-o", fixtureBinary, "-framework", "AppKit", "-framework", "CoreGraphics",
  ], 120_000, false, 256 * 1024);
  await chmod(fixtureBinary, 0o700);

  frontBefore = await frontmostApplication();
  await runProcess("/usr/bin/open", ["-g", fixtureApp, "--args", statusPath, hitPath, dragPath, scrollPath, activationPath], 10_000, false, 64 * 1024);
  const status = await waitForJson(statusPath, 5_000);
  fixturePid = Number(status.pid);
  assert(Number.isInteger(fixturePid) && fixturePid > 0, "fixture did not publish a pid");
  assert(Number.isInteger(Number(status.windowNumber)) && Number(status.windowNumber) > 0, "fixture did not publish a window id");
  assertNormalizedPoint(status.clickProbe, "fixture click probe");
  assertNormalizedPoint(status.dragSource, "fixture drag source");
  assertNormalizedPoint(status.dragDestination, "fixture drag destination");
  assertNormalizedPoint(status.scrollAnchor, "fixture scroll anchor");
  assert.equal(Number(status.scrollInitialOffsetY), 0, "fixture scroll view did not start at offset zero");
  assert.doesNotThrow(() => process.kill(fixturePid, 0), "fixture exited before WindowServer settled its window");
  assert.notEqual(fixturePid, frontBefore.pid, "LaunchServices fixture unexpectedly became frontmost before the smoke action");
  await delay(250);
  fixtureActivationBaseline = await readActivationCount(activationPath);

  const service = new MacosBackgroundInputService({
    runProcess,
    cacheRoot: path.join(root, "background-input-cache"),
    platform: "darwin",
    sourceRoot: packageRoot,
  });
  const applications = new AppAutomationManager({
    policy: {},
    authorizeTool() {},
    displayPath: (value) => String(value),
    runProcess,
    readResourceText: async () => "",
    platform: "darwin",
    home: root,
    backgroundVisualBackend: BACKEND_VALUE,
    backgroundInputService: service,
  });

  const computerUse = new ComputerUseManager({
    authorizeTool() {},
    browserBridgeManager: {},
    appAutomationManager: applications,
  });
  const cuObserved = structuredResult(await computerUse.observe({
    surface: "application",
    application: fixtureName,
    focus_query: "mbm-smoke-button",
    max_depth: 4,
    max_elements: 20,
    timeout_seconds: 10,
  }));
  if (cuObserved.capture.window_coherent !== true) {
    const directWindowState = await applications.inspectApplicationWindow({ application: fixtureName, timeout_seconds: 10 })
      .catch((error) => ({ error: String(error?.message || error) }));
    assert.equal(cuObserved.capture.window_coherent, true,
      `Computer Use did not produce a window-coherent native snapshot: ${JSON.stringify({ capture: cuObserved.capture, directWindowState })}`);
  }
  const cuCheckbox = cuObserved.semantic.elements.find((element) => element.identifier === "mbm-smoke-button");
  assert(cuCheckbox?.ref, "Computer Use observation did not expose the fixture checkbox ref");
  assert.equal(cuCheckbox.checked, false, "Computer Use did not observe the fixture's initial checkbox state");
  const cuUnchecked = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuObserved.snapshot_id,
    action: "uncheck",
    target: { ref: cuCheckbox.ref },
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 100,
    timeout_seconds: 10,
  }));
  assert.equal(cuUnchecked.effect_status, "confirmed",
    `Computer Use uncheck was not confirmed by live Accessibility readback: ${JSON.stringify(cuUnchecked)}`);
  assert.equal(cuUnchecked.dispatch.no_input_required, true, "initial uncheck should be an idempotent no-op");
  assert.match(cuUnchecked.continuation.mapped_post_target_ref || "", /^a\d+$/, "Computer Use did not map the checkbox into the post snapshot");
  const cuChecked = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuUnchecked.post_snapshot_id,
    action: "check",
    target: { ref: cuUnchecked.continuation.mapped_post_target_ref },
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 100,
    timeout_seconds: 10,
  }));
  assert.equal(cuChecked.effect_status, "confirmed", "Computer Use check from the mapped post ref was not confirmed");

  const cuTextObserved = structuredResult(await computerUse.observe({
    surface: "application",
    application: fixtureName,
    focus_query: "mbm-smoke-text",
    include_screenshot: false,
    max_depth: 4,
    max_elements: 20,
    timeout_seconds: 10,
  }));
  const cuText = cuTextObserved.semantic.elements.find((element) => element.identifier === "mbm-smoke-text");
  assert(cuText?.ref, "Computer Use observation did not expose the fixture text-field ref");
  const cuSetValue = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuTextObserved.snapshot_id,
    action: "set_value",
    target: { ref: cuText.ref },
    value: "computer-use-value",
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 100,
    timeout_seconds: 10,
  }));
  assert.equal(cuSetValue.effect_status, "confirmed",
    `Computer Use set_value was not confirmed by private live AXValue comparison: ${JSON.stringify({ verification: cuSetValue.verification, post_observation_error: cuSetValue.post_observation_error || "", observed_diff: cuSetValue.observed_diff })}`);
  assert.equal(cuSetValue.verification.post_checks.some((check) => check.condition === "target_value_matches" && check.matched === true), true);
  const cuTextPostRef = cuSetValue.continuation.mapped_post_target_ref;
  assert.match(cuTextPostRef || "", /^a\d+$/, "Computer Use did not map the text field into the set_value post snapshot");
  await rm(hitPath, { force: true });
  const keyboardText = "甲😀乙".repeat(12);
  const cuKeystroke = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuSetValue.post_snapshot_id,
    action: "keystroke",
    target: { ref: cuTextPostRef },
    value: keyboardText,
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 100,
    timeout_seconds: 10,
  }));
  assert.equal(cuKeystroke.dispatch_status, "completed", "Computer Use Unicode keystroke did not settle as dispatched");
  assert.equal(cuKeystroke.effect_status, "confirmed", "Computer Use Unicode keystroke did not confirm target focus");
  assert.equal(cuKeystroke.dispatch.input_transport, "public-cgevent-pid", "application keystroke did not use public PID keyboard delivery");
  assert.equal(cuKeystroke.dispatch.focus_prepared, true, "application keystroke lost pre-dispatch AX focus provenance");
  const keyboardEvidence = await waitForJson(hitPath, 3_000,
    (value) => value?.type === "keyDown" && Number(value.keyboardDownCount) >= 3);
  assert.equal(Number(keyboardEvidence.windowNumber), Number(status.windowNumber), "application keystroke reached the wrong AppKit window");
  assert.equal(Number(keyboardEvidence.keyboardDownCount), 3, "application keystroke lost the fixed 20-UTF-16-unit chunking contract");
  assert.deepEqual(keyboardEvidence.keyboardChunks.map((chunk) => String(chunk).length), [20, 20, 8],
    "application keystroke split Unicode chunks at unexpected UTF-16 boundaries");
  assert.equal(keyboardEvidence.keyboardText, keyboardText, "application keystroke lost Unicode content or chunk ordering");
  assert.equal(await readActivationCount(activationPath), fixtureActivationBaseline, "application keystroke activated the fixture");

  const cuKeyPressRef = cuKeystroke.continuation.mapped_post_target_ref;
  assert.match(cuKeyPressRef || "", /^a\d+$/, "Computer Use did not map the text field into the keystroke post snapshot");
  await rm(hitPath, { force: true });
  const cuKeyPress = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuKeystroke.post_snapshot_id,
    action: "key_press",
    target: { ref: cuKeyPressRef },
    key: "Shift+Tab",
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 100,
    timeout_seconds: 10,
  }));
  assert.equal(cuKeyPress.dispatch_status, "completed", "Computer Use special key did not settle as dispatched");
  assert.equal(cuKeyPress.effect_status, "unknown", "Computer Use special key incorrectly inferred a stable post-focus effect from pre-dispatch focus preparation");
  assert.equal(cuKeyPress.dispatch.input_transport, "public-cgevent-pid", "application key_press did not use public PID keyboard delivery");
  assert.equal(cuKeyPress.dispatch.focus_prepared, true, "application key_press lost pre-dispatch AX focus provenance");
  const keyPressEvidence = await waitForJson(hitPath, 3_000,
    (value) => value?.type === "keyDown" && Number(value.keyboardDownCount) >= 4);
  assert.equal(Number(keyPressEvidence.windowNumber), Number(status.windowNumber), "application key_press reached the wrong AppKit window");
  assert.equal(Number(keyPressEvidence.keyboardDownCount), 4, "application key_press was not delivered exactly once after Unicode chunks");
  assert.equal(Number(keyPressEvidence.keyboardKeyCode), 0x30, "application key_press did not preserve the layout-independent Tab key code");
  assert.notEqual(Number(keyPressEvidence.keyboardModifierFlags) & (1 << 17), 0, "application key_press lost the Shift modifier");
  assert.equal(await readActivationCount(activationPath), fixtureActivationBaseline, "application key_press activated the fixture");

  const cuFocusObserved = structuredResult(await computerUse.observe({
    surface: "application",
    application: fixtureName,
    focus_query: "mbm-smoke-button",
    include_screenshot: false,
    max_depth: 4,
    max_elements: 20,
    timeout_seconds: 10,
  }));
  const cuFocusCheckbox = cuFocusObserved.semantic.elements.find((element) => element.identifier === "mbm-smoke-button");
  assert(cuFocusCheckbox?.ref, "Computer Use focus observation did not expose the fixture checkbox ref");
  const cuFocused = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuFocusObserved.snapshot_id,
    action: "focus",
    target: { ref: cuFocusCheckbox.ref },
    post_screenshot: "never",
    post_max_depth: 4,
    post_max_elements: 20,
    timeout_seconds: 10,
  }));
  assert.equal(cuFocused.effect_status, "confirmed", "Computer Use semantic ref focus was not confirmed");
  await delay(250);

  const cuRawObserved = structuredResult(await computerUse.observe({
    surface: "application",
    application: fixtureName,
    max_depth: 2,
    max_elements: 20,
    timeout_seconds: 10,
  }));
  await rm(hitPath, { force: true });
  const cuRawPoint = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuRawObserved.snapshot_id,
    action: "click",
    target: { point: status.clickProbe },
    post_screenshot: "always",
    post_max_depth: 2,
    post_max_elements: 20,
    timeout_seconds: 10,
  }));
  const cuRawHit = await waitForJson(hitPath, 3_000);
  assert.equal(cuRawPoint.dispatch.coordinate_source, "macos_skylight_experimental",
    "Computer Use blank-surface point did not fall back to the snapshot-bound native pixel backend");
  assert.equal(cuRawPoint.dispatch_status, "completed");
  assert.equal(Number(cuRawHit.windowNumber), Number(status.windowNumber), "Computer Use raw visual point reached the wrong AppKit window");
  assert.equal(cuRawHit.handledBy, "TargetView", "Computer Use raw visual point entered the window but did not reach the intended AppKit view handler");

  const rawDownCount = Number(cuRawHit.downCount || 0);
  await rm(hitPath, { force: true });
  const cuDoubleClick = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuRawPoint.post_snapshot_id,
    action: "double_click",
    target: { point: status.clickProbe },
    post_screenshot: "always",
    post_max_depth: 2,
    post_max_elements: 20,
    timeout_seconds: 10,
  }));
  const doubleClickEvidence = await waitForJson(hitPath, 3_000,
    (value) => Number(value?.downCount || 0) >= rawDownCount + 2);
  assert.equal(cuDoubleClick.dispatch_status, "completed", "Computer Use background double click did not settle as one completed mutation");
  assert.equal(cuDoubleClick.effect_status, "unknown", "double click without an explicit post-condition was promoted to effect success");
  assert.equal(cuDoubleClick.dispatch.input_transport, "public-cgevent-pid", "AppKit double click did not keep the exact-once public PID transport");
  assert.equal(cuDoubleClick.dispatch.focus_without_raise, false, "AppKit double click unexpectedly performed focus preparation");
  assert.equal(cuDoubleClick.dispatch.screenshot_revalidated, true, "double click did not revalidate the exact window screenshot");
  assert.equal(cuDoubleClick.dispatch.cursor_preserved, true, "background double click moved the hardware cursor");
  assert.equal(Number(doubleClickEvidence.windowNumber), Number(status.windowNumber), "double click reached the wrong AppKit window");
  assert.equal(doubleClickEvidence.handledBy, "TargetView", "double click did not reach the intended AppKit view");
  assert.equal(Number(doubleClickEvidence.downCount) - rawDownCount, 2, "double click duplicated or dropped mouseDown delivery");
  assert.deepEqual((doubleClickEvidence.clickCounts || []).slice(-2).map(Number), [1, 2],
    "double click did not deliver clickCount 1 then 2 exactly once");

  await rm(dragPath, { force: true });
  const cuDrag = structuredResult(await computerUse.act({
    surface: "application",
    snapshot_id: cuDoubleClick.post_snapshot_id,
    action: "drag",
    target: { point: status.dragSource },
    destination: { point: status.dragDestination },
    post_screenshot: "always",
    post_max_depth: 2,
    post_max_elements: 20,
    timeout_seconds: 10,
  }));
  const dragEvidence = await waitForJson(dragPath, 3_000);
  const expectedDragDestination = {
    x: Number(status.dragDestination.x) * Number(cuRawObserved.semantic.selection.window_size.width),
    y: (1 - Number(status.dragDestination.y)) * Number(cuRawObserved.semantic.selection.window_size.height),
  };
  assert.equal(cuDrag.dispatch_status, "completed", "Computer Use background drag did not settle as dispatched");
  assert.equal(cuDrag.dispatch.coordinate_source, "macos_skylight_experimental");
  assert.equal(cuDrag.dispatch.input_transport, "public-cgevent-pid", "native AppKit drag did not use the non-activating public PID route");
  assert.equal(cuDrag.dispatch.cursor_preserved, true, "background drag moved the hardware cursor");
  assert.equal(Number(dragEvidence.windowNumber), Number(status.windowNumber), "background drag reached the wrong AppKit window");
  assert.equal(dragEvidence.lastType, "mouseUp", "background drag did not finish with mouseUp");
  assert.equal(Number(dragEvidence.downCount), 1, "background drag duplicated mouseDown delivery");
  assert.equal(Number(dragEvidence.draggedCount), 8, "background drag did not deliver the fixed eight-step path exactly once");
  assert.equal(Number(dragEvidence.upCount), 1, "background drag duplicated mouseUp delivery");
  assertNear(Number(dragEvidence.x), expectedDragDestination.x, 1.5, "background drag released at the wrong window-local x");
  assertNear(Number(dragEvidence.y), expectedDragDestination.y, 1.5, "background drag released at the wrong window-local y");

  await rm(scrollPath, { force: true });
  const cuScrollResult = await computerUse.act({
    surface: "application",
    snapshot_id: cuDrag.post_snapshot_id,
    action: "scroll",
    target: { point: status.scrollAnchor },
    delta_y: 480,
    expect: { visual_change: true },
    post_screenshot: "always",
    post_max_depth: 2,
    post_max_elements: 20,
    timeout_seconds: 10,
  });
  const cuScroll = structuredResult(cuScrollResult);
  const scrollEvidence = await waitForJson(scrollPath, 3_000);
  assert.equal(cuScroll.dispatch_status, "completed", "Computer Use background scroll did not settle as dispatched");
  assert.equal(cuScroll.effect_status, "confirmed", "Computer Use did not confirm the native scroll from visual post-state");
  assert.equal(cuScroll.dispatch.coordinate_source, "macos_skylight_experimental");
  assert.equal(cuScroll.dispatch.input_transport, "skylight-pid", "native AppKit scroll did not stay on the non-disruptive SkyLight PID route");
  assert.equal(cuScroll.dispatch.cursor_preserved, true, "background scroll moved the hardware cursor");
  assert.deepEqual(cuScroll.dispatch.scroll_delta, { delta_x: 0, delta_y: 480 });
  assert.equal(Number(scrollEvidence.windowNumber), Number(status.windowNumber), "background scroll reached the wrong AppKit window");
  assert.equal(Number(scrollEvidence.eventCount), 1, "background scroll duplicated logical wheel delivery");
  assert.equal(scrollEvidence.precise, true, "background scroll did not use precise pixel-unit wheel delivery");
  assertNear(Number(scrollEvidence.deltaX), 0, 0.01, "background scroll changed the horizontal delta");
  assertNear(Number(scrollEvidence.deltaY), -480, 0.01, "background scroll lost the macOS wheel sign mapping");
  assertNear(Number(scrollEvidence.beforeOffsetY), Number(status.scrollInitialOffsetY), 0.01, "background scroll started from an unexpected content offset");
  assertNear(Number(scrollEvidence.afterOffsetY) - Number(scrollEvidence.beforeOffsetY), 480, 1.5,
    "background wheel was delivered but did not scroll the nested NSScrollView by the requested amount");
  frontAfter = await frontmostApplication();
  const activationCount = await readActivationCount(activationPath);
  assert.notEqual(frontAfter.pid, fixturePid, "background Computer Use left the fixture frontmost");
  assert.equal(activationCount, fixtureActivationBaseline, "background Computer Use activated the fixture application");
  assert.equal(cuRawPoint.dispatch.input_transport, "public-cgevent-pid");
  assert.equal(cuRawPoint.dispatch.focus_without_raise, false, "AppKit visual click unexpectedly performed focus preparation");
  assert.equal(cuDrag.dispatch.focus_without_raise, false, "AppKit drag unexpectedly performed focus preparation");
  assert.equal(cuScroll.dispatch.focus_without_raise, false, "AppKit scroll unexpectedly performed focus preparation");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backend: BACKEND_VALUE,
    fixture: { pid: Number(status.pid), window_id: Number(status.windowNumber) },
    fixture_never_activated: true,
    cursor_preserved: cuRawPoint.dispatch.cursor_preserved === true
      && cuDoubleClick.dispatch.cursor_preserved === true
      && cuDrag.dispatch.cursor_preserved === true
      && cuScroll.dispatch.cursor_preserved === true,
    computer_use_e2e: {
      mapped_post_ref: true,
      desired_state_idempotence: true,
      private_value_readback: true,
      pid_unicode_keystroke: true,
      pid_special_key_press: true,
      semantic_ref_focus: true,
      raw_visual_click: true,
      native_double_click_exact_once: true,
      native_drag_exact_once: true,
      native_scroll_effect_confirmed: true,
    },
    transports: {
      keyboard: cuKeystroke.dispatch.input_transport,
      click: cuRawPoint.dispatch.input_transport,
      double_click: cuDoubleClick.dispatch.input_transport,
      drag: cuDrag.dispatch.input_transport,
      scroll: cuScroll.dispatch.input_transport,
    },
  }, null, 2)}\n`);
} finally {
  if (fixturePid && frontBefore) {
    const current = await frontmostApplication().catch(() => null);
    if (current?.pid === fixturePid) await restoreFrontmost(frontBefore.pid).catch(() => { /* Preserve the smoke-test result; frontmost restoration is best-effort cleanup. */ });
  }
  if (fixturePid) await terminatePid(fixturePid).catch(() => { /* Fixture termination is best-effort cleanup after the primary result is known. */ });
  await rm(root, { recursive: true, force: true }).catch(() => { /* Temporary fixture removal is best-effort cleanup. */ });
}

async function frontmostApplication() {
  const source = String.raw`ObjC.import('AppKit'); const app=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(app.processIdentifier),name:String(ObjC.unwrap(app.localizedName)||'')});`;
  const result = await runProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], 10_000, false, 64 * 1024);
  const parsed = JSON.parse(String(result.stdout || "").trim());
  if (!Number.isInteger(Number(parsed.pid)) || Number(parsed.pid) < 1) throw new Error("could not resolve frontmost application pid");
  return { pid: Number(parsed.pid), name: String(parsed.name || "") };
}

async function restoreFrontmost(pid) {
  const script = `tell application "System Events" to set frontmost of first application process whose unix id is ${Number(pid)} to true`;
  await runProcess("/usr/bin/osascript", ["-e", script], 10_000, true, 64 * 1024);
}

async function readActivationCount(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const count = Number(parsed?.activationCount || 0);
    return Number.isInteger(count) && count >= 0 ? count : 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForJson(file, timeoutMs, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (info.isFile() && info.size > 0 && info.size < 64 * 1024) {
          const parsed = JSON.parse(await handle.readFile("utf8"));
          if (predicate(parsed)) return parsed;
        }
      } finally {
        await handle.close();
      }
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`timed out waiting for fixture evidence${lastError ? ` (${String(lastError.code || lastError.message || lastError)})` : ""}`);
}

async function terminatePid(pid) {
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if (error?.code === "ESRCH") return; else throw error; }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    await delay(50);
    try { process.kill(pid, 0); }
    catch (error) { if (error?.code === "ESRCH") return; else throw error; }
  }
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function fixtureInfoPlist(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>${name}</string>\n<key>CFBundleIdentifier</key><string>dev.machinebridge.smoke.p${process.pid}</string>\n<key>CFBundleName</key><string>${name}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>LSUIElement</key><true/>\n</dict></plist>\n`;
}

function structuredResult(value) {
  return value?.$mcp?.structuredContent || value;
}

function runProcess(cmd, argv, timeoutMs = 30_000, allowFailure = false, maxOutputBytes = 512 * 1024, _context = {}, cwd = undefined, stdin = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const result = {
          code: Number.isInteger(code) ? code : null,
          signal: signal || null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (bytes > maxOutputBytes) reject(new Error(`process output exceeded ${maxOutputBytes} bytes`));
        else if (!allowFailure && code !== 0) reject(new Error(`${cmd} exited with ${code ?? signal}: ${result.stderr.trim()}`));
        else resolve(result);
      }
    });
    if (stdin === null || stdin === undefined) child.stdin.end();
    else child.stdin.end(String(stdin));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function assertNormalizedPoint(value, label) {
  assert(value && typeof value === "object", `${label} is missing`);
  for (const axis of ["x", "y"]) {
    const number = Number(value[axis]);
    assert(Number.isFinite(number) && number >= 0 && number < 1, `${label}.${axis} is outside normalized window space`);
  }
}

function assertNear(actual, expected, tolerance, message) {
  assert(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}
