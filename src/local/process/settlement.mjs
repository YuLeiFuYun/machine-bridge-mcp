// @ts-check
import process from "node:process";
import { MCP_TEXT_PROJECTION_KEY } from "../../shared/result-projection.mjs";
import { sensitiveValuePattern } from "../../shared/sensitive-value-patterns.mjs";
import { BridgeError } from "../core/errors.mjs";

/**
 * Install fail-fast handlers for failures outside an awaited request boundary.
 * The handler deliberately does not attempt asynchronous cleanup: once the event
 * loop's state is unknown, continuing would violate the daemon's fail-closed model.
 * @param {{ logger: { error: (message: string, fields?: Record<string, unknown>) => void }, terminate?: (code: number) => void }} options
 * @param {import('node:events').EventEmitter} [target]
 */
export function installFatalProcessHandlers(options, target = process) {
  let terminating = false;
  /** @type {(code: number) => void} */
  const defaultTerminate = (code) => process.exit(code);
  const terminate = typeof options.terminate === "function" ? options.terminate : defaultTerminate;
  /** @param {string} event */
  const handle = (event) => {
    if (terminating) return;
    terminating = true;
    try {
      options.logger.error("fatal process failure; terminating", {
        fatal_event: event,
        // Rejection values and even their code/prototype properties may execute user code.
        error_class: "execution_failed",
      });
    } catch {
      // The process is already in a fatal path; never let logging prevent termination.
    }
    terminate(1);
  };
  const onUncaughtException = () => handle("uncaught_exception");
  const onUnhandledRejection = () => handle("unhandled_rejection");
  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);
  return () => {
    target.removeListener("uncaughtException", onUncaughtException);
    target.removeListener("unhandledRejection", onUnhandledRejection);
  };
}
/**
 * @typedef {{
 *   onSettle?: (code: number | null, signal: string | null, source: "close" | "exit_fallback") => void,
 *   onFallback?: () => void,
 *   schedule?: (callback: () => void, delay: number) => unknown,
 *   clearSchedule?: (timer: unknown) => void,
 *   fallbackMs?: unknown,
 *   readExitState?: () => { code?: number | null, signal?: string | null },
 * }} ChildProcessSettlementOptions
 */

/** @param {ChildProcessSettlementOptions} [options] */
export function createChildProcessSettlement(options = {}) {
  if (typeof options.onSettle !== "function") throw new TypeError("child settlement requires onSettle");
  const onSettle = options.onSettle;
  /** @type {(callback: () => void, delay: number) => unknown} */
  const defaultSchedule = (callback, delay) => setTimeout(callback, delay);
  /** @type {(timer: unknown) => void} */
  const defaultClearSchedule = timer => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer));
  const schedule = typeof options.schedule === "function" ? options.schedule : defaultSchedule;
  const clearSchedule = typeof options.clearSchedule === "function" ? options.clearSchedule : defaultClearSchedule;
  const delay = boundedDelay(options.fallbackMs);
  let settled = false;
  /** @type {unknown} */
  let timer = null;
  let timerSet = false;

  /**
   * @param {number | null} code
   * @param {string | null} signal
   * @param {"close" | "exit_fallback"} source
   */
  function settle(code, signal, source) {
    if (settled) return false;
    settled = true;
    if (timerSet) clearSchedule(timer);
    timer = null;
    timerSet = false;
    onSettle(code, signal, source);
    return true;
  }

  /** @param {number | null} code @param {string | null} signal */
  function onClose(code, signal) { return settle(code, signal, "close"); }

  /** @param {number | null} code @param {string | null} signal */
  function onExit(code, signal) {
    if (settled || timerSet) return false;
    timerSet = true;
    timer = schedule(() => {
      timer = null;
      timerSet = false;
      options.onFallback?.();
      const observed = safeExitState(options.readExitState);
      const settledCode = typeof observed.code === "number" && Number.isInteger(observed.code) ? observed.code : code;
      const settledSignal = observed.signal || signal;
      settle(settledCode, settledSignal, "exit_fallback");
    }, delay);
    return true;
  }

  function cancel() {
    if (settled) return false;
    settled = true;
    if (timerSet) clearSchedule(timer);
    timer = null;
    timerSet = false;
    return true;
  }

  return Object.freeze({ onClose, onExit, cancel });
}

/**
 * Attach the shared close-preferred settlement policy to one ChildProcess-like object.
 * Residual stdio is destroyed only after exit has been observed and the bounded close grace expired.
 * @param {any} child
 * @param {ChildProcessSettlementOptions} options
 */
export function attachChildProcessSettlement(child, options = {}) {
  const settlement = createChildProcessSettlement({
    ...options,
    readExitState: options.readExitState || (() => ({ code: child?.exitCode, signal: child?.signalCode })),
    onFallback() {
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
        try { stream?.destroy?.(); }
        catch { /* The process has exited; residual stream destruction is bounded best-effort cleanup. */ }
      }
      try { child?.unref?.(); }
      catch { /* Detachment is advisory after process exit and cannot change the settlement result. */ }
      options.onFallback?.();
    },
  });
  /** @param {number | null} code @param {string | null} signal */
  const onExit = (code, signal) => settlement.onExit(code, signal);
  /** @param {number | null} code @param {string | null} signal */
  const onClose = (code, signal) => settlement.onClose(code, signal);
  child.once("exit", onExit);
  child.once("close", onClose);
  return settlement;
}

/** @param {unknown} value */
function boundedDelay(value) {
  if (value === undefined) return 1000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
    throw new TypeError("child settlement fallback must be between 0 and 10000 milliseconds");
  }
  return Math.floor(parsed);
}

export function childExitedBeforeTimeout({ exitCode = null, signalCode = null, processState = "unknown" } = {}) {
  return Number.isInteger(exitCode) || Boolean(signalCode) || processState === "zombie";
}

/** @param {ChildProcessSettlementOptions["readExitState"]} reader @returns {{ code: number | null, signal: string | null }} */
function safeExitState(reader) {
  if (typeof reader !== "function") return { code: null, signal: null };
  try {
    const value = reader();
    const code = value?.code;
    const signal = value?.signal;
    return {
      code: typeof code === "number" && Number.isInteger(code) ? code : null,
      signal: typeof signal === "string" && signal ? signal : null,
    };
  } catch {
    return { code: null, signal: null };
  }
}
const PRIVATE_KEY_BLOCK = /-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]{1,16384}?-----END\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g;

const BINARY_PAYLOAD_PATTERN = /(?:\\x[0-9a-fA-F]{2}){8,}/g;

const REVERSE_SHELL_PATTERN = /\b(?:bash|sh|zsh)\s+-i\s+>&\s*\/dev\/tcp\/[^\s]+|\bnc\s+-e\s+\/bin\/(?:ba)?sh\b/g;

const INTERACTIVE_PROMPT_TAIL_PATTERN = /(?:(?:\[(?:y\/n|Y\/n|y\/N)\]|(?:\(y\/n\))|(?:\b(?:password|passphrase)\b[^:\r\n]{0,40}:)|(?:\bcontinue\?\s*\(?[yYnN/]+\)?)|(?:\boverwrite\b[^?\r\n]{0,40}\?))\s*)$/i;

/** @type {ReadonlyArray<[RegExp, string]>} */
const PROCESS_REPLACEMENTS = Object.freeze([
  [PRIVATE_KEY_BLOCK, "<redacted:private_key>"],
  [sensitiveValuePattern("privateKeyHeader", "g"), "<redacted:private_key_header>"],
  [sensitiveValuePattern("awsAccessKey", "g"), "<redacted:aws_key>"],
  [sensitiveValuePattern("githubAccessToken", "g"), "<redacted:github_token>"],
  [sensitiveValuePattern("gitlabAccessToken", "g"), "<redacted:gitlab_token>"],
  [sensitiveValuePattern("npmAccessToken", "g"), "<redacted:npm_token>"],
  [sensitiveValuePattern("slackAccessToken", "g"), "<redacted:slack_token>"],
  [sensitiveValuePattern("googleApiKey", "g"), "<redacted:google_api_key>"],
  [sensitiveValuePattern("livePaymentApiKey", "g"), "<redacted:payment_key>"],
  [sensitiveValuePattern("apiSecretToken", "g"), "<redacted:api_secret>"],
  [sensitiveValuePattern("jwtLikeBearerToken", "g"), "<redacted:jwt_token>"],
  [sensitiveValuePattern("credentialUrl", "g"), "https://<redacted:credentials>@$1"],
  [BINARY_PAYLOAD_PATTERN, "<redacted:binary_payload>"],
  [REVERSE_SHELL_PATTERN, "<redacted:reverse_shell>"],
]);

/** @param {unknown} text @returns {string} */
export function redactSensitiveProcessOutput(text) {
  if (typeof text !== "string" || !text) return "";
  let current = text;
  for (const [pattern, replacement] of PROCESS_REPLACEMENTS) current = current.replace(pattern, replacement);
  return current;
}

/** @param {string} stdout @param {string} stderr @returns {string | null} */
export function detectInteractivePromptStall(stdout, stderr) {
  const combinedTail = `${String(stdout || "").slice(-256)}\n${String(stderr || "").slice(-256)}`.trim();
  const match = combinedTail ? INTERACTIVE_PROMPT_TAIL_PATTERN.exec(combinedTail) : null;
  return match ? match[0].trim() : null;
}

/** @param {string} stderr @param {string} stdout @param {number | null | undefined} code @returns {string} */
export function refusalPreventionAdvisory(stderr, stdout, code) {
  if (code === 0) return "";
  const combined = `${stderr || ""}\n${stdout || ""}`;
  if (/SSL certificate problem|unable to get local issuer certificate|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(combined)) {
    return " [SRE Advisory: Certificate verification failed. Inspect local CA bundle or use `openssl s_client` / `curl -v` to diagnose the TLS chain rather than disabling verification globally.]";
  }
  if (/operation not permitted|permission denied|EACCES|EPERM/i.test(combined) && /nmap|tcpdump|wireshark|raw socket/i.test(combined)) {
    return " [SRE Advisory: Elevated packet capture or port probe failed due to OS privileges. Use unprivileged socket diagnostics (`nc -zv`, `lsof -i`, `ss -tulpn`, or `curl -v`) instead.]";
  }
  if (/command not found: (?:nmap|masscan|rustscan|nikto|sqlmap|hydra|john|hashcat)|(?:nmap|masscan|tcpdump): command not found/i.test(combined)) {
    return " [SRE Advisory: Raw packet capture or broad port scanning is unavailable in this environment. Use standard POSIX/network diagnostics (`lsof -i`, `netstat -an`, `nc -zv`, `dig`, or `curl -v`) to inspect service reachability.]";
  }
  const promptStall = detectInteractivePromptStall(stdout, stderr);
  return promptStall
    ? ` [SRE Advisory: Process output ended at an interactive prompt (${JSON.stringify(promptStall)}). Pass non-interactive flags (e.g., --yes, -y, CI=1, GIT_TERMINAL_PROMPT=0) or use start_process + write_process for interactive sessions.]`
    : "";
}

/** @param {Record<string, any>} value */
export function publicProcessToolResult(value) {
  const safeStdout = typeof value.stdout === "string" ? redactSensitiveProcessOutput(value.stdout) : value.stdout;
  const safeStderr = typeof value.stderr === "string" ? redactSensitiveProcessOutput(value.stderr) : value.stderr;
  const truncated = Number(value.stdout_truncated_bytes) + Number(value.stderr_truncated_bytes);
  const continuation = value.output_session_id
    ? ` Continue with read_process session ${value.output_session_id}.`
    : truncated > 0 ? " Additional output could not be retained because the process-session limit was reached." : "";
  const advisory = refusalPreventionAdvisory(safeStderr, safeStdout, value.code);
  const summary = `Process exited with code ${value.code}.${truncated > 0 ? ` ${truncated} inline byte(s) omitted.` : ""}${continuation}${advisory}`;
  return {
    ...value,
    ...(typeof safeStdout === "string" ? { stdout: safeStdout } : {}),
    ...(typeof safeStderr === "string" ? { stderr: safeStderr } : {}),
    [MCP_TEXT_PROJECTION_KEY]: summary,
  };
}

/** @param {string} trigger @param {Record<string, unknown>} [details] */
export function processOutcomeUnknownAfterSpawn(trigger, details = {}) {
  const terminationRequested = trigger === "cancelled" || trigger === "timeout" || trigger === "resource_binding";
  return new BridgeError(
    "execution_failed",
    "command execution may have partially completed; the outcome is unknown. Inspect command effects before retrying.",
    {
      expose: true,
      retryable: false,
      details: {
        ...details,
        reason: "process_outcome_unknown_after_spawn",
        trigger: String(trigger || "unknown").slice(0, 64),
        side_effects_started: "unknown",
        termination_requested: terminationRequested,
        effect_settlement: terminationRequested ? "pending" : "unknown",
      },
    },
  );
}

/** @param {Record<string, any>} result */
export function processFailureMessage(result) {
  const safeStderr = redactSensitiveProcessOutput(String(result.stderr || ""));
  const safeStdout = redactSensitiveProcessOutput(String(result.stdout || ""));
  const advisory = refusalPreventionAdvisory(safeStderr, safeStdout, result.code);
  const source = String(safeStderr || safeStdout || `process exited ${result.code}`).replace(/[\r\n]+/g, " ").trim().slice(0, 2000);
  const suffix = result.output_session_id
    ? `; additional output is available through read_process session ${result.output_session_id}`
    : result.stdout_truncated_bytes > 0 || result.stderr_truncated_bytes > 0 ? "; additional output was truncated" : "";
  return `${source || `process exited ${result.code}`}${suffix}${advisory}`;
}
/** @param {unknown} error @param {boolean} nonReplayable */
export function processPreSpawnFailure(error, nonReplayable) {
  if (!nonReplayable || error instanceof BridgeError) return error;
  return new BridgeError("execution_failed", "process failed before spawn", {
    cause: error instanceof Error ? error : undefined,
    retryable: false,
    details: { reason: "process_failed_before_spawn" },
  });
}

/** @param {boolean} nonReplayable @param {AbortSignal | undefined} signal */
export function processCancellationFailure(nonReplayable, signal) {
  const reason = signal?.reason;
  const code = reason instanceof BridgeError && reason.code === "timeout" ? "timeout" : "cancelled";
  if (nonReplayable) return processOutcomeUnknownAfterSpawn(code);
  return new BridgeError(code, reason instanceof Error ? reason.message : "tool call cancelled", {
    retryable: false,
    cause: reason instanceof Error ? reason : undefined,
    details: { side_effects_started: true, termination_requested: true, effect_settlement: "pending" },
  });
}

/** @param {boolean} nonReplayable @param {number} timeoutMs */
export function processTimeoutFailure(nonReplayable, timeoutMs) {
  if (nonReplayable) return processOutcomeUnknownAfterSpawn("timeout");
  return new BridgeError("timeout", `command timed out after ${timeoutMs}ms`, {
    retryable: false,
    details: { side_effects_started: true, termination_requested: true, effect_settlement: "pending" },
  });
}

/** @param {boolean} nonReplayable @param {string} trigger @param {unknown} fallback @param {Record<string, unknown>} [details] */
export function processPostSpawnFailure(nonReplayable, trigger, fallback, details = {}) {
  return nonReplayable ? processOutcomeUnknownAfterSpawn(trigger, details) : fallback;
}

/** @param {boolean} nonReplayable @param {unknown} error @param {boolean} started */
export function processChildErrorFailure(nonReplayable, error, started) {
  if (!nonReplayable) return error;
  if (started) return processOutcomeUnknownAfterSpawn("process_error");
  return new BridgeError("execution_failed", "process failed before spawn", {
    cause: error instanceof Error ? error : undefined,
    retryable: false,
    details: { reason: "process_failed_before_spawn" },
  });
}
/**
 * Bounded byte stream shared by interactive process sessions and completed
 * one-shot command continuations. It retains the newest bytes while keeping
 * monotonic offsets so callers can detect data that aged out of the buffer.
 */
export class ProcessOutputStream {
  /** @param {number} maximumBytes */
  constructor(maximumBytes) {
    const maximum = Number(maximumBytes);
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("maximum retained output bytes must be a positive safe integer");
    }
    this.maximumBytes = maximum;
    this.storage = Buffer.alloc(maximum);
    this.writeOffset = 0;
    this.retainedBytes = 0;
    this.baseOffset = 0;
    this.totalBytes = 0;
  }

  get buffer() {
    const start = (this.writeOffset - this.retainedBytes + this.maximumBytes) % this.maximumBytes;
    const end = start + this.retainedBytes;
    if (end <= this.maximumBytes) return Buffer.from(this.storage.subarray(start, end));
    return Buffer.concat([
      this.storage.subarray(start),
      this.storage.subarray(0, end - this.maximumBytes),
    ], this.retainedBytes);
  }

  /** @param {unknown} chunk */
  append(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    if (!input.length) return;
    this.totalBytes += input.length;
    if (input.length >= this.maximumBytes) {
      this.storage.set(input.subarray(input.length - this.maximumBytes));
      this.writeOffset = 0;
      this.retainedBytes = this.maximumBytes;
      this.baseOffset = this.totalBytes - this.retainedBytes;
      return;
    }
    const first = Math.min(input.length, this.maximumBytes - this.writeOffset);
    this.storage.set(input.subarray(0, first), this.writeOffset);
    if (first < input.length) this.storage.set(input.subarray(first), 0);
    this.writeOffset = (this.writeOffset + input.length) % this.maximumBytes;
    this.retainedBytes = Math.min(this.maximumBytes, this.retainedBytes + input.length);
    this.baseOffset = this.totalBytes - this.retainedBytes;
  }

  /** @param {unknown} requestedOffset @param {unknown} maximumBytes */
  read(requestedOffset, maximumBytes) {
    const requested = nonNegativeInteger(requestedOffset);
    const maximum = positiveInteger(maximumBytes);
    const clampedOffset = Math.min(requested, this.totalBytes);
    const effectiveOffset = Math.max(clampedOffset, this.baseOffset);
    const start = effectiveOffset - this.baseOffset;
    const length = Math.min(maximum, this.retainedBytes - start);
    const ringStart = (this.writeOffset - this.retainedBytes + start + this.maximumBytes) % this.maximumBytes;
    const ringEnd = ringStart + length;
    const slice = length <= 0 ? Buffer.alloc(0)
      : ringEnd <= this.maximumBytes ? this.storage.subarray(ringStart, ringEnd)
        : Buffer.concat([this.storage.subarray(ringStart), this.storage.subarray(0, ringEnd - this.maximumBytes)], length);
    const decoded = decodeProcessBytes(slice);
    return {
      ...decoded,
      requested_offset: requested,
      start_offset: effectiveOffset,
      next_offset: effectiveOffset + slice.length,
      total_offset: this.totalBytes,
      retained_start_offset: this.baseOffset,
      truncated_before: requested < this.baseOffset,
      truncated_after: effectiveOffset + slice.length < this.totalBytes,
    };
  }

}

/** @param {Buffer} bytes */
function decodeProcessBytes(bytes) {
  try {
    return { data: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return {
      data: new TextDecoder("utf-8").decode(bytes),
      data_base64: bytes.toString("base64"),
      encoding: "base64",
    };
  }
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return number;
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return 1;
  return number;
}
/** @param {{ origin?: string }} [context] @param {{ beginActivity?: () => void, endActivity?: () => void } | null} [guard] */
export function beginRemoteProcessSessionActivity(context, guard) {
  if (context?.origin !== "relay" || !guard) return false;
  try { guard.beginActivity?.(); } catch { /* Auxiliary power management must not change session startup. */ }
  return true;
}

/** @param {boolean} held @param {{ beginActivity?: () => void, endActivity?: () => void } | null} [guard] */
export function endRemoteProcessSessionActivity(held, guard) {
  if (!held || !guard) return;
  try { guard.endActivity?.(); } catch { /* Auxiliary power management must not change session settlement. */ }
}
/** @type {Readonly<Record<string, string>>} */
export const STRUCTURED_GIT_FIXED_ENVIRONMENT = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
});

/** @param {unknown} value @returns {Readonly<Record<string, string>>} */
export function validateFixedProcessEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", "internal process environment must be an object");
  }
  /** @type {Record<string, string>} */
  const normalized = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(STRUCTURED_GIT_FIXED_ENVIRONMENT, key) || raw !== STRUCTURED_GIT_FIXED_ENVIRONMENT[key]) {
      throw new BridgeError("invalid_request", "internal process environment override is not approved");
    }
    normalized[key] = raw;
  }
  return Object.freeze(normalized);
}
const PROCESS_LOCK_READ_ATTEMPTS = 4;

const PROCESS_LOCK_IDENTITY_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * @template T
 * @param {() => T} callback
 * @returns {T}
 */
export function retryProcessLockIdentityReadSync(callback) {
  if (typeof callback !== "function") throw new TypeError("process-lock identity retry requires a callback");
  for (let attempt = 1; attempt <= PROCESS_LOCK_READ_ATTEMPTS; attempt += 1) {
    try { return callback(); }
    catch (error) {
      const err = /** @type {any} */ (error);
      const identityChanged = err?.code === "MBM_IDENTITY_CHANGED" || err?.cause?.code === "MBM_IDENTITY_CHANGED";
      if (!identityChanged || attempt === PROCESS_LOCK_READ_ATTEMPTS) throw error;
      Atomics.wait(PROCESS_LOCK_IDENTITY_RETRY_BUFFER, 0, 0, 1);
    }
  }
  throw new Error("process lock identity did not settle");
}
