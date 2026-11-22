import { BridgeError } from "../core/errors.mjs";
import { REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS } from "../../shared/foreground-timeout.mjs";
import { resolve, win32, basename } from "node:path";
import { managedJobDependencyCount } from "./dependencies.mjs";
import { ACTIVE_JOB_STATES, isTerminalManagedJobStatus } from "./terminal-base.mjs";

const DURABLE_PROCESS_SOURCE_TOOLS = new Set(["exec_command", "run_process", "run_local_command"]);

export function startDurableProcessJob(manager, args = {}, context = {}) {
  const sourceTool = String(args.sourceTool || "");
  if (!DURABLE_PROCESS_SOURCE_TOOLS.has(sourceTool)) {
    throw new BridgeError("invalid_request", "durable process execution requires a supported process source tool");
  }
  manager.authorizeTool(sourceTool);
  manager.assertMaintenanceAvailable();
  const timeoutSeconds = args.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS) {
    throw new BridgeError("invalid_request", `durable process execution timeout must be an integer from 1 to ${REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS} seconds`);
  }
  const accepted = manager.createJob({
    name: String(args.name || `durable ${sourceTool}`).slice(0, 128),
    ...(args.idempotencyKey === undefined ? {} : { idempotency_key: args.idempotencyKey }),
    steps: [{
      name: sourceTool,
      argv: args.argv,
      cwd: args.cwd,
      timeout_seconds: timeoutSeconds,
      capture_output: "redacted",
    }],
  }, {
    launch: true,
    executionPriority: "interactive",
    retentionClass: "transient_process",
  }, context);
  return {
    ...accepted,
    execution_mode: "durable_job",
    source_tool: sourceTool,
    execution_timeout_seconds: timeoutSeconds,
    progress: { status: accepted.status, current_phase: null, current_step: null },
    recovery: {
      tool: "read_job",
      job_id: accepted.job_id,
      fallback_tool: "list_jobs",
      survives_mcp_disconnect: true,
      survives_daemon_restart: true,
    },
    retry_safety: args.idempotencyKey === undefined
      ? "retain job_id and inspect list_jobs before resubmitting after an ambiguous acceptance failure"
      : "retry the same tool arguments with the same idempotency_key to recover the same durable job",
  };
}
export const MAX_MANAGED_JOB_RECOVERY_ATTEMPTS = 3;

const RECOVERY_REASONS = new Set(["runner_interrupted", "dependency_wait_runner_interrupted"]);

export function managedJobRecoveryAttempts(status) {
  const value = status?.recovery_attempts;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MANAGED_JOB_RECOVERY_ATTEMPTS) throw recoveryIntegrityError();
  return value;
}

export function managedJobRecoveryHistory(status) {
  const attempts = managedJobRecoveryAttempts(status);
  const value = status?.recovery_history;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > attempts || (attempts > 0 && value.length === 0)) throw recoveryIntegrityError();
  const firstAttempt = attempts - value.length + 1;
  const history = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join(",") !== "at,attempt,reason"
        || entry.attempt !== firstAttempt + index
        || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))
        || typeof entry.reason !== "string" || !RECOVERY_REASONS.has(entry.reason)) throw recoveryIntegrityError();
    return { attempt: entry.attempt, at: entry.at, reason: entry.reason };
  });
  return history;
}

export function managedJobRecoveryHistoryComplete(status) {
  const attempts = managedJobRecoveryAttempts(status);
  return managedJobRecoveryHistory(status).length === attempts;
}

export function appendManagedJobRecovery(status, reason) {
  if (!RECOVERY_REASONS.has(reason)) throw recoveryIntegrityError();
  const attempts = managedJobRecoveryAttempts(status);
  if (attempts >= MAX_MANAGED_JOB_RECOVERY_ATTEMPTS) throw recoveryIntegrityError();
  const history = managedJobRecoveryHistory(status);
  const attempt = attempts + 1;
  const at = new Date().toISOString();
  status.recovery_attempts = attempt;
  status.recovery_history = [...history, { attempt, at, reason }].slice(-MAX_MANAGED_JOB_RECOVERY_ATTEMPTS);
  return at;
}

function recoveryIntegrityError() {
  return new BridgeError("integrity_error", "managed job recovery metadata is invalid");
}
export function managedJobResourcePathVariants(value, platform = process.platform) {
  const canonical = platform === "win32" ? win32.resolve(value) : resolve(value);
  const variants = new Set(pathTextVariants(canonical));
  if (platform === "darwin" && canonical.startsWith("/private/")) {
    for (const variant of pathTextVariants(canonical.slice("/private".length))) variants.add(variant);
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

export function redactManagedJobOutput(buffer, context, runtimeDir, platform = process.platform, truncatedBytes = 0) {
  const safeBuffer = discardUnsafeTruncationTail(buffer, context, runtimeDir, platform, truncatedBytes);
  const redactedBytes = replaceBufferEntries(safeBuffer, byteRedactionEntries(context, runtimeDir, platform));
  let text = new TextDecoder("utf-8").decode(redactedBytes);
  for (const entry of textRedactionEntries(context, runtimeDir, platform)) {
    text = replaceTextEntry(text, entry, platform);
  }
  return text;
}

function discardUnsafeTruncationTail(buffer, context, runtimeDir, platform, truncatedBytes) {
  if (!(Number(truncatedBytes) > 0) || !Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  const foldCase = platform === "win32" || platform === "darwin";
  const patterns = protectedBytePatterns(context, runtimeDir, platform)
    .map(pattern => foldCase ? asciiCaseFold(pattern) : pattern);
  let end = buffer.length;
  while (end > 0) {
    const prefix = buffer.subarray(0, end);
    const view = foldCase ? asciiCaseFold(prefix) : prefix;
    let longest = 0;
    for (const pattern of patterns) longest = Math.max(longest, partialSuffixLength(view, pattern));
    if (longest === 0) break;
    end -= longest;
  }
  return end === buffer.length ? buffer : buffer.subarray(0, end);
}

function protectedBytePatterns(context, runtimeDir, platform) {
  const values = [];
  for (const value of Object.values(context.bytes || {})) {
    if (Buffer.isBuffer(value) && value.length) values.push(value);
  }
  for (const path of Object.values(context.paths || {})) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  for (const paths of Object.values(context.sourcePaths || {})) {
    for (const path of paths || []) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  }
  for (const path of Object.values(context.temporaryPaths || {})) values.push(...managedJobResourcePathVariants(path, platform).map((value) => Buffer.from(value)));
  values.push(...managedJobResourcePathVariants(runtimeDir, platform).map((value) => Buffer.from(value)));
  for (const [, value] of literalRedactionEntries(context)) values.push(Buffer.from(value));
  const unique = new Map();
  for (const value of values) if (value.length) unique.set(value.toString("hex"), value);
  return [...unique.values()].sort((left, right) => right.length - left.length);
}

function literalRedactionEntries(context) {
  const entries = [];
  for (const [name, patterns] of Object.entries(context.redactions || {})) {
    if (!Array.isArray(patterns)) continue;
    for (const value of patterns) {
      if (typeof value === "string" && value.length > 0) entries.push([name, value]);
    }
  }
  return entries.sort((left, right) => right[1].length - left[1].length);
}

function pathRedactionEntries(context, runtimeDir, platform) {
  const entries = [];
  const add = (value, replacement) => {
    for (const variant of managedJobResourcePathVariants(value, platform)) {
      if (variant) entries.push({ value: variant, replacement, caseInsensitive: true });
    }
  };
  for (const [name, path] of Object.entries(context.paths || {})) add(path, `<resource:${name}>`);
  for (const [name, paths] of Object.entries(context.sourcePaths || {})) {
    for (const path of paths || []) add(path, `<resource-source:${name}>`);
  }
  for (const [name, path] of Object.entries(context.temporaryPaths || {})) add(path, `<temp:${name}>`);
  add(runtimeDir, "<job-runtime>");
  return entries;
}

function textRedactionEntries(context, runtimeDir, platform) {
  if (platform !== "win32" && platform !== "darwin") return [];
  return pathRedactionEntries(context, runtimeDir, platform)
    .map((entry) => ({ ...entry, caseInsensitive: true }))
    .sort((left, right) => right.value.length - left.value.length);
}

function byteRedactionEntries(context, runtimeDir, platform) {
  const entries = [];
  for (const [name, value] of Object.entries(context.bytes || {})) {
    if (Buffer.isBuffer(value) && value.length > 0) {
      entries.push({ pattern: value, replacement: Buffer.from(`<redacted-resource:${name}>`) });
    }
  }
  for (const entry of pathRedactionEntries(context, runtimeDir, platform)) {
    entries.push({ pattern: Buffer.from(entry.value), replacement: Buffer.from(entry.replacement) });
  }
  for (const [name, value] of literalRedactionEntries(context)) {
    entries.push({ pattern: Buffer.from(value), replacement: Buffer.from(`<redacted-resource:${name}>`) });
  }
  return entries.sort((left, right) => right.pattern.length - left.pattern.length);
}

// Windows case aliases must also be protected at a truncated capture boundary.
function asciiCaseFold(buffer) {
  const folded = Buffer.from(buffer);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 65 && folded[index] <= 90) folded[index] += 32;
  }
  return folded;
}

function partialSuffixLength(buffer, pattern) {
  if (!pattern?.length || !buffer.length) return 0;
  if (pattern.length <= buffer.length && buffer.subarray(buffer.length - pattern.length).equals(pattern)) return 0;
  const minimumStart = Math.max(0, buffer.length - pattern.length + 1);
  let start = minimumStart;
  while (start < buffer.length) {
    const candidate = buffer.indexOf(pattern[0], start);
    if (candidate < 0) return 0;
    const length = buffer.length - candidate;
    if (length < pattern.length && buffer.subarray(candidate).equals(pattern.subarray(0, length))) return length;
    start = candidate + 1;
  }
  return 0;
}

function replaceBufferEntries(buffer, entries) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || entries.length === 0) return buffer;
  const parts = [];
  let cursor = 0;
  let literalStart = 0;
  while (cursor < buffer.length) {
    const entry = entries.find(({ pattern }) => cursor + pattern.length <= buffer.length
      && buffer.subarray(cursor, cursor + pattern.length).equals(pattern));
    if (!entry) { cursor += 1; continue; }
    if (cursor > literalStart) parts.push(buffer.subarray(literalStart, cursor));
    parts.push(entry.replacement);
    cursor += entry.pattern.length;
    literalStart = cursor;
  }
  if (literalStart === 0) return buffer;
  if (literalStart < buffer.length) parts.push(buffer.subarray(literalStart));
  return Buffer.concat(parts);
}

function pathTextVariants(value) {
  const path = String(value);
  return [...new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])];
}

function replaceTextEntry(text, entry, platform) {
  if (!entry.value) return text;
  if ((platform === "win32" || platform === "darwin") && entry.caseInsensitive) {
    return text.replace(new RegExp(RegExp.escape(entry.value), "gi"), entry.replacement);
  }
  return text.split(entry.value).join(entry.replacement);
}
export function acceptedManagedJobProjection(status, plan, { idempotencyReplay = false, idempotencyAccepted = true } = {}) {
  return {
    accepted: true,
    job_id: status.job_id,
    name: status.name,
    status: status.status,
    ...(plan.continuation_mode === "task_supervisor" ? { continuation_mode: "task_supervisor" } : {}),
    detached: true,
    continues_without_mcp_connection: true,
    approval: status.approval,
    plan_sha256: status.plan_sha256,
    dependency_total: managedJobDependencyCount(status.dependency_total),
    dependency_pending_count: managedJobDependencyCount(status.dependency_pending_count),
    ...(idempotencyAccepted ? { idempotency_key_accepted: true, idempotency_replay: idempotencyReplay } : {}),
    recovery: {
      tool: "read_job",
      job_id: status.job_id,
      survives_mcp_disconnect: true,
      survives_daemon_restart: true,
      same_response_followup_supported: true,
    },
    cleanup: {
      resource_copies: "best-effort",
      finally_steps: plan.finally_steps.length ? "best-effort" : "none-declared",
      restart_recovery: "best-effort-on-runner-exit-or-next-runtime-or-cli-start",
    },
  };
}
export function isKnownManagedJobStatus(value) {
  return value === "staged" || ACTIVE_JOB_STATES.has(value) || isTerminalManagedJobStatus(value);
}

export function assertManagedJobDirectoryIdentity(dir, status) {
  if (status?.job_id !== basename(dir)) {
    throw new BridgeError("integrity_error", "managed job state does not match its directory");
  }
}

export function assertKnownManagedJobStatus(status) {
  if (!isKnownManagedJobStatus(status?.status)) {
    throw new BridgeError("integrity_error", "managed job status is invalid");
  }
  managedJobRecoveryHistory(status);
}

export function managedJobTransitionConflict() {
  return new BridgeError("conflict", "job state is being modified by another process; retry after inspecting its current status", {
    retryable: true,
    details: { job_transition_pending: true },
  });
}
