import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeError } from "../src/local/errors.mjs";
import { MacosBackgroundInputService, applicationBackgroundInputConfiguration } from "../src/local/macos-background-input.mjs";

await buildsOnceAndProjectsSuccessfulClick();
await projectsPublicPidKeyboardWithoutVisualOptIn();
await classifiesPublicPidKeyboardSettlement();
await projectsSuccessfulDoubleClick();
await projectsSuccessfulDrag();
await projectsSuccessfulScroll();
await classifiesPreDispatchAndUnknownFailures();
await cachesProbeStateAndSupportsExplicitReprobe();
await cancelledProbeDoesNotPoisonCachedCapability();
await cancelledBuildOwnerDoesNotCancelWaiter();
console.log("macOS background input service test ok");

async function projectsPublicPidKeyboardWithoutVisualOptIn() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-pid-keyboard-test-"));
  const cacheRoot = path.join(root, "cache");
  const helperPayloads = [];
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    helperPayloads.push(payload);
    return { code: 0, stdout: `${JSON.stringify({
      ok: true, backend: "skylight-experimental", focus_without_raise: false,
      frontmost_restored: false, dispatch_started: true, input_transport: "public-cgevent-pid",
    })}\n`, stderr: "" };
  };
  try {
    assert.throws(() => new MacosBackgroundInputService({ runProcess, cacheRoot: [cacheRoot], platform: "darwin", sourceRoot: path.resolve(".") }), /absolute cacheRoot string/);
    assert.throws(() => new MacosBackgroundInputService({ runProcess, cacheRoot: "relative-cache", platform: "darwin", sourceRoot: path.resolve(".") }), /absolute cacheRoot string/);
    assert.throws(() => applicationBackgroundInputConfiguration({
      platform: "darwin", backgroundVisualBackend: ["disabled"],
    }, runProcess, root), /backgroundVisualBackend must be disabled or skylight-experimental/);
    const configured = applicationBackgroundInputConfiguration({
      platform: "darwin", backgroundVisualBackend: "disabled",
    }, runProcess, root);
    assert.equal(configured.backgroundVisualBackend, "disabled");
    assert(configured.backgroundInputService instanceof MacosBackgroundInputService,
      "public PID keyboard helper was incorrectly coupled to the private visual backend opt-in");

    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const typed = await service.keystroke({ pid: 321, process_generation: "gen-321", text: "甲😀乙", timeout_seconds: 5 });
    assert.equal(typed.input_transport, "public-cgevent-pid");
    assert.equal(service.status().probed, false, "public PID keyboard dispatch unexpectedly probed private SkyLight symbols");
    const pressed = await service.keyPress({ pid: 321, process_generation: "gen-321", key: "Shift+Tab", timeout_seconds: 5 });
    assert.equal(pressed.input_transport, "public-cgevent-pid");
    assert.deepEqual(helperPayloads, [
      { operation: "unicode_keystroke", pid: 321, process_generation: "gen-321", text: "甲😀乙" },
      { operation: "key_press", pid: 321, process_generation: "gen-321", key: "Shift+Tab" },
    ]);
    await assert.rejects(() => service.keystroke({ pid: 321, process_generation: "gen-321", text: "" }), /text is invalid before dispatch/);
    await assert.rejects(() => service.keystroke({ pid: 321, process_generation: "gen-321", text: ["x"] }), /text is invalid before dispatch/);
    await assert.rejects(() => service.keyPress({ pid: 321, process_generation: "gen-321", key: "Meta+A" }), /unsupported before dispatch/);
    await assert.rejects(() => service.keyPress({ pid: 321, process_generation: "gen-321", key: ["Enter"] }), /unsupported before dispatch/);
    await assert.rejects(() => service.keystroke({ pid: "321", process_generation: "gen-321", text: "x" }), /pid must be a positive integer/);
    await assert.rejects(() => service.keystroke({ pid: 321, process_generation: "gen-321", text: "x", timeout_seconds: "5" }), /timeout_seconds must be from 1 to 120/);
    await assert.rejects(() => service.keyPress({ pid: 321, process_generation: ["gen-321"], key: "Enter" }), /process_generation is invalid/);
    assert.equal(helperPayloads.length, 2, "invalid or coercible keyboard authority reached the native helper");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function classifiesPublicPidKeyboardSettlement() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-pid-keyboard-settlement-test-"));
  const cacheRoot = path.join(root, "cache");
  let mode = "pre-dispatch-generation";
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    JSON.parse(stdin);
    if (mode === "pre-dispatch-generation") {
      return { code: 4, stdout: `${JSON.stringify({
        ok: false, dispatch_started: false, error: "process_generation_changed_before_dispatch", input_transport: "public-cgevent-pid",
      })}\n`, stderr: "" };
    }
    if (mode === "post-dispatch-unknown") {
      return { code: 4, stdout: `${JSON.stringify({
        ok: false, dispatch_started: true, error: "dispatch_outcome_unknown", input_transport: "public-cgevent-pid",
      })}\n`, stderr: "" };
    }
    throw new BridgeError("unavailable", "synthetic post-spawn settlement loss", {
      details: { reason: "process_outcome_unknown_after_spawn" },
    });
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    await assert.rejects(
      () => service.keystroke({ pid: 321, process_generation: "gen-321", text: "x" }),
      /process generation changed before dispatch/,
    );
    mode = "post-dispatch-unknown";
    await assert.rejects(
      () => service.keystroke({ pid: 321, process_generation: "gen-321", text: "x" }),
      /may have been partially dispatched; the action outcome is unknown/,
    );
    mode = "process-settlement-unknown";
    await assert.rejects(
      () => service.keyPress({ pid: 321, process_generation: "gen-321", key: "Enter" }),
      /macOS native background input may have been partially dispatched; the action outcome is unknown/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildsOnceAndProjectsSuccessfulClick() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-input-test-"));
  const cacheRoot = path.join(root, "cache");
  const calls = [];
  let helperRuns = 0;
  const runProcess = async (cmd, argv, _timeoutMs, allowFailure, _maxOutput, _context, _cwd, stdin) => {
    calls.push({ cmd, argv: [...argv], allowFailure, stdin });
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    helperRuns += 1;
    const payload = JSON.parse(stdin);
    if (payload.operation === "probe") {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
    }
    assert.equal(payload.operation, "click");
    assert.deepEqual(payload, {
      operation: "click", pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
    });
    return {
      code: 0,
      stdout: `${JSON.stringify({
        ok: true, backend: "skylight-experimental", focus_without_raise: true,
        frontmost_restored: false, front_window_validated: true, cursor_preserved: true,
        dispatch_started: true, input_transport: "public-cgevent-pid",
      })}\n`,
      stderr: "",
    };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    assert.deepEqual(service.status(), {
      configured: true, probed: false, available: false, backend: "skylight-experimental", error: "",
    });
    const probe = await service.probe();
    assert.equal(probe.ok, true);
    assert.deepEqual(service.status(), {
      configured: true, probed: true, available: true, backend: "skylight-experimental", error: "",
    });
    const result = await service.click({
      pid: 123, process_generation: "gen-123", window_id: 456, screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300, timeout_seconds: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.focus_without_raise, true);
    assert.equal(result.front_window_validated, true);
    assert.equal(result.cursor_preserved, true);
    assert.equal(result.input_transport, "public-cgevent-pid");
    assert.equal(result.error, "");
    await assert.rejects(() => service.click({
      pid: 123, process_generation: "gen-123", window_id: 456, screen_x: [100], screen_y: 200, local_x: 20, local_y: 30,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300, timeout_seconds: 5,
    }), /screen_x must be finite/);
    assert.equal(helperRuns, 2, "coercible visual coordinate reached the native helper");
    const compileCalls = calls.filter((call) => call.cmd === "/usr/bin/xcrun");
    assert(compileCalls.length >= 1, "helper was never compiled");
    // The cache trust predicate intentionally requires POSIX executable mode bits. Windows chmod cannot
    // provide that evidence for this synthetic forced-darwin fixture, so exact compile-once reuse is
    // asserted by POSIX/macOS hosts while Windows continues to exercise the remaining helper contract.
    if (process.platform !== "win32") {
      assert.equal(compileCalls.length, 1, "helper compiled more than once for the same source digest");
    }
    const compiledSource = compileCalls[0].argv[2];
    assert(compiledSource.startsWith(cacheRoot), "swiftc read the mutable package source instead of a hashed owner-only source copy");
    await assert.rejects(() => stat(compiledSource), (error) => error?.code === "ENOENT", "temporary hashed Swift source was not removed after compilation");
    assert.equal(helperRuns, 2);
    const binary = calls.find((call) => call.cmd !== "/usr/bin/xcrun")?.cmd;
    assert(binary?.startsWith(cacheRoot), "helper binary escaped the dedicated runtime cache root");
    assert.equal((await readFile(binary, "utf8")).trim(), "synthetic-helper");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function projectsSuccessfulDoubleClick() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-double-click-test-"));
  const cacheRoot = path.join(root, "cache");
  const calls = [];
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    if (payload.operation === "probe") {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
    }
    calls.push(payload);
    return { code: 0, stdout: `${JSON.stringify({
      ok: true, backend: "skylight-experimental", focus_without_raise: true,
      frontmost_restored: false, front_window_validated: true, cursor_preserved: true,
      dispatch_started: true, input_transport: "public-cgevent-pid",
    })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const result = await service.click({
      pid: 123, process_generation: "gen-123", window_id: 456, screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      click_count: 2, window_x: 80, window_y: 170, window_width: 400, window_height: 300, timeout_seconds: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.input_transport, "public-cgevent-pid");
    assert.deepEqual(calls, [{
      operation: "click", pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 100, screen_y: 200, local_x: 20, local_y: 30, click_count: 2,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
    }]);
    await assert.rejects(() => service.click({
      pid: 123, process_generation: "gen-123", window_id: 456, screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      click_count: 3, window_x: 80, window_y: 170, window_width: 400, window_height: 300,
    }), /click_count must be 1 or 2/);
    assert.equal(calls.length, 1, "invalid click_count reached the native helper");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function projectsSuccessfulDrag() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-drag-test-"));
  const cacheRoot = path.join(root, "cache");
  const calls = [];
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    if (payload.operation === "probe") {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
    }
    calls.push(payload);
    return { code: 0, stdout: `${JSON.stringify({
      ok: true, backend: "skylight-experimental", focus_without_raise: true,
      frontmost_restored: true, front_window_validated: true, cursor_preserved: true,
      dispatch_started: true, input_transport: "public-cgevent-pid",
    })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const result = await service.drag({
      pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      destination_screen_x: 300, destination_screen_y: 350,
      destination_local_x: 220, destination_local_y: 180,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
      timeout_seconds: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.cursor_preserved, true);
    assert.equal(result.frontmost_restored, true);
    assert.equal(result.input_transport, "public-cgevent-pid");
    assert.deepEqual(calls, [{
      operation: "drag", pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
      destination_screen_x: 300, destination_screen_y: 350,
      destination_local_x: 220, destination_local_y: 180,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function projectsSuccessfulScroll() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-scroll-test-"));
  const cacheRoot = path.join(root, "cache");
  const calls = [];
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    if (payload.operation === "probe") {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
    }
    calls.push(payload);
    return { code: 0, stdout: `${JSON.stringify({
      ok: true, backend: "skylight-experimental", focus_without_raise: true,
      frontmost_restored: false, front_window_validated: true, cursor_preserved: true,
      dispatch_started: true, input_transport: "public-cgevent-pid",
    })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const result = await service.scroll({
      pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 200, screen_y: 250, local_x: 120, local_y: 80,
      delta_x: 120.4, delta_y: 479.6,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
      timeout_seconds: 5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.cursor_preserved, true);
    assert.equal(result.input_transport, "public-cgevent-pid");
    assert.deepEqual(calls, [{
      operation: "scroll", pid: 123, process_generation: "gen-123", window_id: 456,
      screen_x: 200, screen_y: 250, local_x: 120, local_y: 80,
      delta_x: 120, delta_y: 480,
      window_x: 80, window_y: 170, window_width: 400, window_height: 300,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function classifiesPreDispatchAndUnknownFailures() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-input-fail-"));
  const cacheRoot = path.join(root, "cache");
  let mode = "pre";
  const mutationOptions = [];
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin, options = {}) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    if (payload.operation === "probe") {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
    }
    assert.equal(payload.operation, "click");
    mutationOptions.push(options);
    if (mode === "launch_policy") throw new BridgeError("policy_denied", "delegated helper blocked before spawn");
    if (mode === "launch_cancel") throw new BridgeError("cancelled", "helper cancelled before spawn");
    if (mode === "post_spawn_cancel") {
      throw new BridgeError("execution_failed", "helper process outcome unknown", {
        retryable: false, details: { reason: "process_outcome_unknown_after_spawn", trigger: "cancelled" },
      });
    }
    if (mode === "pre") {
      return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: false, error: "front_window_changed_before_dispatch" })}\n`, stderr: "" };
    }
    if (mode === "generation") {
      return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: false, error: "process_generation_changed_before_dispatch" })}\n`, stderr: "" };
    }
    if (mode === "frontmost") {
      return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: false, error: "frontmost_changed_before_input" })}\n`, stderr: "" };
    }
    if (mode === "input") {
      return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: false, error: "input_unavailable_before_dispatch" })}\n`, stderr: "" };
    }
    if (mode === "response_loss") return { code: 0, stdout: "not-json\n", stderr: "" };
    if (mode === "coercible_generation") return { code: 4, stdout: `${JSON.stringify({ ok: false, dispatch_started: false, error: ["process_generation_changed_before_dispatch"] })}\n`, stderr: "" };
    if (mode === "coercible_stdout") return { code: 4, stdout: [`${JSON.stringify({ ok: false, dispatch_started: false, error: "process_generation_changed_before_dispatch" })}\n`], stderr: "" };
    if (mode === "coercible_optional") return { code: 0, stdout: `${JSON.stringify({ ok: true, dispatch_started: true, input_transport: "public-cgevent-pid", cursor_preserved: [true] })}\n`, stderr: "" };
    if (mode === "incomplete") return { code: 0, stdout: "{}\n", stderr: "" };
    return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: true, error: "dispatch_outcome_unknown" })}\n`, stderr: "" };
  };
  const args = {
    pid: 123, process_generation: "gen-123", window_id: 456, screen_x: 100, screen_y: 200, local_x: 20, local_y: 30,
    window_x: 80, window_y: 170, window_width: 400, window_height: 300,
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    await assert.rejects(() => service.click(args), /unavailable before dispatch: front_window_changed_before_dispatch/);
    mode = "generation";
    await assert.rejects(() => service.click(args), /unavailable before dispatch: process_generation_changed_before_dispatch/,
      "generation mismatch lost its definite pre-dispatch settlement");
    mode = "frontmost";
    await assert.rejects(() => service.click(args), /unavailable before dispatch: frontmost_changed_before_input/,
      "pre-input frontmost drift was incorrectly promoted to an unknown mutation before focus/input started");
    mode = "input";
    await assert.rejects(() => service.click(args), /unavailable before dispatch: input_unavailable_before_dispatch/,
      "zero-mutation pointer boundary failure was incorrectly promoted to an unknown mutation");
    mode = "launch_policy";
    await assert.rejects(() => service.click(args), /unavailable before dispatch: policy_denied/,
      "definite helper launch policy failure was incorrectly promoted to an unknown mutation");
    mode = "launch_cancel";
    await assert.rejects(() => service.click(args), (error) => error instanceof BridgeError && error.code === "cancelled",
      "pre-spawn helper cancellation lost its definite cancellation settlement");
    mode = "post_spawn_cancel";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "post-spawn helper cancellation was incorrectly treated as a definite launch failure");
    mode = "response_loss";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "lost or malformed click-helper settlement was incorrectly treated as a pre-dispatch failure");
    mode = "coercible_generation";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "coercible native helper error became a definite process-generation pre-dispatch failure");
    mode = "coercible_stdout";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "coercible native helper stdout became a definite mutation settlement");
    mode = "coercible_optional";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "coercible native helper postcondition flag was accepted on a successful mutation settlement");
    mode = "incomplete";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i,
      "incomplete but valid click-helper JSON was incorrectly accepted as a pre-dispatch failure");
    mode = "unknown";
    await assert.rejects(() => service.click(args), /partially dispatched.*outcome is unknown/i);
    assert.equal(mutationOptions.length, 13, "failure settlement fixture did not execute every expected mutation attempt");
    assert.equal(mutationOptions.every((value) => value?.nonReplayableMutation === true), true,
      "macOS helper mutation did not request process-level non-replayable settlement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cancelledProbeDoesNotPoisonCachedCapability() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-input-cancelled-probe-"));
  const cacheRoot = path.join(root, "cache");
  let probeRuns = 0;
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    assert.equal(payload.operation, "probe");
    probeRuns += 1;
    if (probeRuns === 1 || probeRuns === 3) throw new BridgeError("cancelled", "operation cancelled");
    return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    await assert.rejects(() => service.probe(), (error) => error?.code === "cancelled",
      "cancelled SkyLight capability probe was converted into a cached probe failure");
    assert.equal(service.status().probed, false, "cancelled probe poisoned the cached capability state");
    const recovered = await service.probe();
    assert.equal(recovered.ok, true, "ordinary probe did not retry after cancellation left no stable capability result");
    assert.equal(probeRuns, 2, "cancelled probe was incorrectly reused as a cached failure");
    assert.equal(service.status().available, true);
    await assert.rejects(() => service.probe({}, { force: true }), (error) => error?.code === "cancelled",
      "cancelled forced reprobe was converted into a cached capability failure");
    assert.equal(service.status().available, true, "cancelled forced reprobe erased the prior stable capability result");
    const cached = await service.probe();
    assert.equal(cached.ok, true, "ordinary probe did not retain the stable result after a cancelled forced reprobe");
    assert.equal(probeRuns, 3, "cancelled forced reprobe caused the stable cache to be discarded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cancelledBuildOwnerDoesNotCancelWaiter() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-input-shared-build-"));
  const cacheRoot = path.join(root, "cache");
  const compileContexts = [];
  let compileRuns = 0;
  let rejectFirstCompile;
  let markFirstCompileStarted;
  const firstCompileStarted = new Promise((resolve) => { markFirstCompileStarted = resolve; });
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      compileRuns += 1;
      compileContexts.push(context?.callId || "");
      if (compileRuns === 1) {
        markFirstCompileStarted();
        await new Promise((_resolve, reject) => { rejectFirstCompile = reject; });
      }
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    assert.equal(payload.operation, "probe");
    return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const owner = service.probe({ callId: "cancelled-owner" }, { force: true });
    await firstCompileStarted;
    const waiter = service.probe({ callId: "active-waiter" }, { force: true });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    rejectFirstCompile(new BridgeError("cancelled", "owner build cancelled"));
    await assert.rejects(() => owner, (error) => error?.code === "cancelled",
      "build owner cancellation was unexpectedly retried by the cancelled owner");
    const recovered = await waiter;
    assert.equal(recovered.ok, true, "uncancelled waiter inherited another call's cancelled shared build");
    assert.deepEqual(compileContexts, ["cancelled-owner", "active-waiter"],
      "shared helper build was not retried under the waiting call's own context");
    assert.equal(compileRuns, 2, "shared cancelled build caused an unexpected number of compiler attempts");
    assert.equal(service.status().available, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cachesProbeStateAndSupportsExplicitReprobe() {
  const root = await mkdtemp(path.join(tmpdir(), "mbm-bg-input-probe-"));
  const cacheRoot = path.join(root, "cache");
  let probeRuns = 0;
  const runProcess = async (cmd, argv, _timeoutMs, _allowFailure, _maxOutput, _context, _cwd, stdin) => {
    if (cmd === "/usr/bin/xcrun") {
      const output = argv[argv.indexOf("-o") + 1];
      await writeFile(output, "synthetic-helper\n", "utf8");
      await chmod(output, 0o700);
      return { code: 0, stdout: "", stderr: "" };
    }
    const payload = JSON.parse(stdin);
    assert.equal(payload.operation, "probe");
    probeRuns += 1;
    if (probeRuns === 1) {
      return { code: 4, stdout: `${JSON.stringify({ ok: false, backend: "skylight-experimental", dispatch_started: false, error: "private_symbols_unavailable_before_dispatch" })}\n`, stderr: "" };
    }
    return { code: 0, stdout: `${JSON.stringify({ ok: true, backend: "skylight-experimental", dispatch_started: false })}\n`, stderr: "" };
  };
  try {
    const service = new MacosBackgroundInputService({ runProcess, cacheRoot, platform: "darwin", sourceRoot: path.resolve(".") });
    const failed = await service.probe();
    assert.equal(failed.ok, false);
    assert.equal(service.status().error, "private_symbols_unavailable_before_dispatch");
    const cached = await service.probe();
    assert.equal(cached.ok, false);
    assert.equal(probeRuns, 1, "failed probe was retried implicitly instead of remaining a stable runtime capability result");
    const recovered = await service.probe({}, { force: true });
    assert.equal(recovered.ok, true);
    assert.equal(probeRuns, 2);
    assert.equal(service.status().available, true);
    assert.equal(service.status().error, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
