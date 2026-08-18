import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorCode } from "./errors.mjs";
import { packageRoot } from "./package-identity.mjs";

const SOURCE_RELATIVE = path.join("native", "macos", "MachineBridgeBackgroundInput.swift");
const MAX_OUTPUT_BYTES = 64 * 1024;

export class MacosBackgroundInputService {
  constructor({ runProcess, cacheRoot, platform = process.platform, sourceRoot = packageRoot }) {
    if (typeof runProcess !== "function") throw new Error("macOS background input requires runProcess");
    if (typeof cacheRoot !== "string" || !cacheRoot || !path.isAbsolute(cacheRoot)) throw new Error("macOS background input requires an absolute cacheRoot string");
    this.runProcess = runProcess;
    this.cacheRoot = path.resolve(cacheRoot);
    this.platform = platform;
    this.sourcePath = path.resolve(sourceRoot, SOURCE_RELATIVE);
    this.binaryPath = "";
    this.buildPromise = null;
    this.lastProbe = null;
  }

  configured() {
    return this.platform === "darwin";
  }

  status() {
    return {
      configured: this.configured(),
      probed: this.lastProbe !== null,
      available: this.lastProbe?.ok === true,
      backend: "skylight-experimental",
      error: safeErrorCode(this.lastProbe?.error),
    };
  }

  async probe(context = {}, { force = false } = {}) {
    if (!this.configured()) {
      this.lastProbe = { ok: false, backend: "skylight-experimental", error: "unsupported_platform_before_dispatch" };
      return { ...this.lastProbe };
    }
    if (!force && this.lastProbe) return { ...this.lastProbe };
    try {
      const result = await this.runHelper({ operation: "probe" }, 30, context);
      this.lastProbe = { ...result, error: safeErrorCode(result.error) };
    } catch (error) {
      if (errorCode(error) === "cancelled") throw error;
      this.lastProbe = { ok: false, backend: "skylight-experimental", error: "helper_probe_failed_before_dispatch" };
    }
    return { ...this.lastProbe };
  }

  async click(args = {}, context = {}) {
    if (!this.configured()) throw new Error("macOS SkyLight background input unavailable before dispatch");
    const probe = await this.probe(context);
    if (probe.ok !== true) throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(probe.error) || "probe_failed"}`);
    const clickCount = args.click_count === undefined ? 1 : positiveInteger(args.click_count, "click_count");
    if (clickCount > 2) throw new Error("macOS background click_count must be 1 or 2");
    const payload = {
      operation: "click",
      pid: positiveInteger(args.pid, "pid"),
      process_generation: requiredProcessGeneration(args.process_generation),
      window_id: positiveInteger(args.window_id, "window_id"),
      screen_x: finiteNumber(args.screen_x, "screen_x"),
      screen_y: finiteNumber(args.screen_y, "screen_y"),
      local_x: nonNegativeFinite(args.local_x, "local_x"),
      local_y: nonNegativeFinite(args.local_y, "local_y"),
      ...(clickCount === 1 ? {} : { click_count: clickCount }),
      window_x: finiteNumber(args.window_x, "window_x"),
      window_y: finiteNumber(args.window_y, "window_y"),
      window_width: positiveFinite(args.window_width, "window_width"),
      window_height: positiveFinite(args.window_height, "window_height"),
    };
    const result = await this.runHelper(payload, boundedTimeout(args.timeout_seconds), context, { mutating: true });
    if (result.ok === true) return result;
    if (result.dispatch_started === true || result.error === "dispatch_outcome_unknown") {
      throw new Error("macOS SkyLight background input may have been partially dispatched; the action outcome is unknown");
    }
    throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(result.error)}`);
  }

  async drag(args = {}, context = {}) {
    if (!this.configured()) throw new Error("macOS SkyLight background input unavailable before dispatch");
    const probe = await this.probe(context);
    if (probe.ok !== true) throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(probe.error) || "probe_failed"}`);
    const payload = {
      operation: "drag",
      pid: positiveInteger(args.pid, "pid"),
      process_generation: requiredProcessGeneration(args.process_generation),
      window_id: positiveInteger(args.window_id, "window_id"),
      screen_x: finiteNumber(args.screen_x, "screen_x"),
      screen_y: finiteNumber(args.screen_y, "screen_y"),
      local_x: nonNegativeFinite(args.local_x, "local_x"),
      local_y: nonNegativeFinite(args.local_y, "local_y"),
      destination_screen_x: finiteNumber(args.destination_screen_x, "destination_screen_x"),
      destination_screen_y: finiteNumber(args.destination_screen_y, "destination_screen_y"),
      destination_local_x: nonNegativeFinite(args.destination_local_x, "destination_local_x"),
      destination_local_y: nonNegativeFinite(args.destination_local_y, "destination_local_y"),
      window_x: finiteNumber(args.window_x, "window_x"),
      window_y: finiteNumber(args.window_y, "window_y"),
      window_width: positiveFinite(args.window_width, "window_width"),
      window_height: positiveFinite(args.window_height, "window_height"),
    };
    const result = await this.runHelper(payload, boundedTimeout(args.timeout_seconds), context, { mutating: true });
    if (result.ok === true) return result;
    if (result.dispatch_started === true || result.error === "dispatch_outcome_unknown") {
      throw new Error("macOS SkyLight background input may have been partially dispatched; the action outcome is unknown");
    }
    throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(result.error)}`);
  }

  async scroll(args = {}, context = {}) {
    if (!this.configured()) throw new Error("macOS SkyLight background input unavailable before dispatch");
    const probe = await this.probe(context);
    if (probe.ok !== true) throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(probe.error) || "probe_failed"}`);
    const deltaX = scrollDelta(args.delta_x, "delta_x");
    const deltaY = scrollDelta(args.delta_y, "delta_y");
    if (deltaX === 0 && deltaY === 0) throw new Error("macOS background scroll requires a non-zero delta_x or delta_y");
    const payload = {
      operation: "scroll",
      pid: positiveInteger(args.pid, "pid"),
      process_generation: requiredProcessGeneration(args.process_generation),
      window_id: positiveInteger(args.window_id, "window_id"),
      screen_x: finiteNumber(args.screen_x, "screen_x"),
      screen_y: finiteNumber(args.screen_y, "screen_y"),
      local_x: nonNegativeFinite(args.local_x, "local_x"),
      local_y: nonNegativeFinite(args.local_y, "local_y"),
      delta_x: deltaX,
      delta_y: deltaY,
      window_x: finiteNumber(args.window_x, "window_x"),
      window_y: finiteNumber(args.window_y, "window_y"),
      window_width: positiveFinite(args.window_width, "window_width"),
      window_height: positiveFinite(args.window_height, "window_height"),
    };
    const result = await this.runHelper(payload, boundedTimeout(args.timeout_seconds), context, { mutating: true });
    if (result.ok === true) return result;
    if (result.dispatch_started === true || result.error === "dispatch_outcome_unknown") {
      throw new Error("macOS SkyLight background input may have been partially dispatched; the action outcome is unknown");
    }
    throw new Error(`macOS SkyLight background input unavailable before dispatch: ${safeErrorCode(result.error)}`);
  }

  async keystroke(args = {}, context = {}) {
    if (!this.configured()) throw new Error("macOS PID keyboard input unavailable before dispatch");
    const text = args.text;
    if (typeof text !== "string" || !text || text.includes("\0") || text.length > 4000) throw new Error("macOS PID keystroke text is invalid before dispatch");
    const result = await this.runHelper({
      operation: "unicode_keystroke",
      pid: positiveInteger(args.pid, "pid"),
      process_generation: requiredProcessGeneration(args.process_generation),
      text,
    }, boundedTimeout(args.timeout_seconds), context, { mutating: true });
    return requireKeyboardSettlement(result);
  }

  async keyPress(args = {}, context = {}) {
    if (!this.configured()) throw new Error("macOS PID keyboard input unavailable before dispatch");
    const result = await this.runHelper({
      operation: "key_press",
      pid: positiveInteger(args.pid, "pid"),
      process_generation: requiredProcessGeneration(args.process_generation),
      key: requiredSpecialKey(args.key),
    }, boundedTimeout(args.timeout_seconds), context, { mutating: true });
    return requireKeyboardSettlement(result);
  }

  async runHelper(payload, timeoutSeconds, context, { mutating = false } = {}) {
    const binary = await this.ensureBuilt(context);
    let result;
    try {
      result = await this.runProcess(
        binary,
        [],
        timeoutSeconds * 1000,
        true,
        MAX_OUTPUT_BYTES,
        context,
        undefined,
        `${JSON.stringify(payload)}\n`,
        mutating ? { nonReplayableMutation: true } : {},
      );
    } catch (error) {
      if (mutating && error?.details?.reason === "process_outcome_unknown_after_spawn") throw backgroundInputOutcomeUnknown();
      if (mutating && errorCode(error) !== "cancelled") {
        throw new Error(`macOS native input helper unavailable before dispatch: ${safeErrorCode(errorCode(error))}`);
      }
      throw error;
    }
    if (!result || typeof result !== "object" || Array.isArray(result)
        || !Number.isSafeInteger(result.code) || typeof result.stdout !== "string") {
      if (mutating) throw backgroundInputOutcomeUnknown();
      throw new Error("macOS native input helper returned an invalid process settlement before dispatch");
    }
    const output = result.stdout.trim();
    let parsed;
    try { parsed = JSON.parse(output); }
    catch {
      if (mutating) throw backgroundInputOutcomeUnknown();
      throw new Error("macOS native input helper returned invalid JSON before dispatch");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (mutating) throw backgroundInputOutcomeUnknown();
      throw new Error("macOS native input helper returned an invalid response before dispatch");
    }
    if (mutating && (typeof parsed.ok !== "boolean" || typeof parsed.dispatch_started !== "boolean"
        || parsed.ok === true && parsed.dispatch_started !== true)) {
      throw backgroundInputOutcomeUnknown();
    }
    if (mutating) {
      if (Object.hasOwn(parsed, "error") && parsed.error !== null
          && (typeof parsed.error !== "string" || !/^[a-z0-9_-]{1,100}$/.test(parsed.error))) {
        throw backgroundInputOutcomeUnknown();
      }
      if (parsed.ok === false && parsed.dispatch_started === false
          && (typeof parsed.error !== "string" || !/^[a-z0-9_-]{1,100}$/.test(parsed.error))) {
        throw backgroundInputOutcomeUnknown();
      }
      if (parsed.ok === true && !["public-cgevent-pid", "skylight-pid"].includes(parsed.input_transport)) {
        throw backgroundInputOutcomeUnknown();
      }
      for (const field of ["focus_without_raise", "frontmost_restored", "front_window_validated", "cursor_preserved"]) {
        if (Object.hasOwn(parsed, field) && parsed[field] !== null && typeof parsed[field] !== "boolean") {
          throw backgroundInputOutcomeUnknown();
        }
      }
    }
    return {
      ok: parsed.ok === true,
      backend: "skylight-experimental",
      focus_without_raise: parsed.focus_without_raise === true,
      frontmost_restored: parsed.frontmost_restored === true,
      front_window_validated: parsed.front_window_validated === true,
      cursor_preserved: parsed.cursor_preserved === true,
      dispatch_started: parsed.dispatch_started === true,
      input_transport: ["public-cgevent-pid", "skylight-pid"].includes(parsed.input_transport) ? parsed.input_transport : "",
      error: safeErrorCode(parsed.error),
      exit_code: result.code,
    };
  }

  async ensureBuilt(context) {
    while (true) {
      if (this.binaryPath && await executableRegularFile(this.binaryPath)) return this.binaryPath;
      let owned = false;
      let pending = this.buildPromise;
      if (!pending) {
        owned = true;
        pending = this.startBuild(context);
      }
      try { return await pending; }
      catch (error) {
        if (errorCode(error) !== "cancelled" || owned) throw error;
      }
    }
  }

  startBuild(context) {
    const pending = this.build(context)
      .then((binary) => { this.binaryPath = binary; return binary; })
      .finally(() => { if (this.buildPromise === pending) this.buildPromise = null; });
    this.buildPromise = pending;
    return pending;
  }

  async build(context) {
    if (!this.configured()) throw new Error("macOS native input helper unavailable before dispatch");
    const source = await readFile(this.sourcePath);
    const digest = createHash("sha256").update(source).update(`\0${process.arch}\0`).digest("hex");
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    await chmod(this.cacheRoot, 0o700);
    const output = path.join(this.cacheRoot, `background-input-${digest.slice(0, 24)}`);
    if (await executableRegularFile(output)) return output;
    const temporary = `${output}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const temporarySource = `${temporary}.swift`;
    try {
      await writeFile(temporarySource, source, { mode: 0o600, flag: "wx" });
      await this.runProcess(
        "/usr/bin/xcrun",
        ["swiftc", "-O", temporarySource, "-o", temporary, "-framework", "CoreGraphics", "-framework", "AppKit"],
        120_000,
        false,
        256 * 1024,
        context,
      );
      await chmod(temporary, 0o700);
      try { await rename(temporary, output); }
      catch (error) {
        if (!await executableRegularFile(output)) throw error;
      }
      await chmod(output, 0o700);
      return output;
    } finally {
      await rm(temporary, { force: true }).catch(() => { /* Preserve the primary native-helper result; temp cleanup is best-effort. */ });
      await rm(temporarySource, { force: true }).catch(() => { /* Preserve the primary native-helper result; source cleanup is best-effort. */ });
    }
  }
}

export function applicationBackgroundInputConfiguration(applicationAutomation, runProcess, runtimeDir) {
  const configuredBackend = applicationAutomation.backgroundVisualBackend === undefined
    ? process.env.MBM_MACOS_BACKGROUND_VISUAL_BACKEND || "disabled"
    : applicationAutomation.backgroundVisualBackend;
  if (typeof configuredBackend !== "string") throw new Error("backgroundVisualBackend must be disabled or skylight-experimental");
  const backgroundVisualBackend = configuredBackend;
  const applicationPlatform = applicationAutomation.platform || process.platform;
  const backgroundInputService = applicationAutomation.backgroundInputService
    || (applicationPlatform === "darwin"
      ? new MacosBackgroundInputService({
          runProcess,
          cacheRoot: path.resolve(runtimeDir, "macos-background-input"),
          platform: applicationPlatform,
        })
      : null);
  return { backgroundVisualBackend, backgroundInputService };
}

async function executableRegularFile(value) {
  try {
    const info = await lstat(value);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const trustedOwner = currentUid === null || info.uid === currentUid || info.uid === 0;
    return info.isFile() && !info.isSymbolicLink() && trustedOwner && (info.mode & 0o111) !== 0 && (info.mode & 0o022) === 0;
  } catch { return false; }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredProcessGeneration(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error("process_generation is invalid");
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegativeFinite(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function scrollDelta(value, label) {
  if (value === undefined || value === null) return 0;
  const number = finiteNumber(value, label);
  if (Math.abs(number) > 10_000) throw new Error(`${label} must be from -10000 to 10000`);
  return Object.is(number, -0) ? 0 : Math.round(number);
}

function positiveFinite(value, label) {
  const number = finiteNumber(value, label);
  if (!(number > 0)) throw new Error(`${label} must be positive`);
  return number;
}

function requiredSpecialKey(value) {
  if (typeof value !== "string") throw new Error("macOS PID key_press key is unsupported before dispatch");
  const key = value;
  const raw = key.startsWith("Shift+") ? key.slice(6) : key;
  const allowed = new Set([
    "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
    "Home", "End", "PageUp", "PageDown", "Space",
  ]);
  if (!allowed.has(raw) || key !== raw && key !== `Shift+${raw}`) throw new Error("macOS PID key_press key is unsupported before dispatch");
  return key;
}

function requireKeyboardSettlement(result) {
  if (result.ok === true && result.dispatch_started === true && result.input_transport === "public-cgevent-pid") return result;
  if (result.dispatch_started === true || result.error === "dispatch_outcome_unknown") {
    throw new Error("macOS PID keyboard input may have been partially dispatched; the action outcome is unknown");
  }
  if (result.error === "process_generation_changed_before_dispatch") {
    throw new Error("macOS PID keyboard process generation changed before dispatch");
  }
  throw new Error(`macOS PID keyboard input unavailable before dispatch: ${safeErrorCode(result.error)}`);
}

function boundedTimeout(value) {
  if (value === undefined || value === null) return 30;
  if (!Number.isInteger(value) || value < 1 || value > 120) throw new Error("timeout_seconds must be from 1 to 120");
  return value;
}

function backgroundInputOutcomeUnknown() {
  return new Error("macOS native background input may have been partially dispatched; the action outcome is unknown");
}

function safeErrorCode(value) {
  if (typeof value !== "string") return "";
  const text = value.trim().toLowerCase();
  if (!text) return "";
  return /^[a-z0-9_-]{1,100}$/.test(text) ? text : "helper_error";
}
