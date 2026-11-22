// @ts-check
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { isRelayReadyContext } from "../transport/relay-classification.mjs";
import { handleRuntimeRelayShutdownAck } from "./runtime-relay-drain.mjs";
import { positiveInteger } from "../../shared/numbers.mjs";

/** @typedef {{origin?: unknown, authority?: {owner?: unknown, principal?: {kind?: unknown} | null} | null}} ActivityContext */

/** @param {ActivityContext} [context] */
export function runtimeActivityVisible(context = {}) {
  const authority = context?.authority;
  if (context?.origin === "relay" || authority?.principal?.kind === "account") return authority?.owner === true;
  return true;
}

export function hiddenGlobalActivity() {
  return { activity_hidden_by_authority: true };
}

/** @param {Record<string, unknown>} [snapshot] */
export function hiddenInFlightActivity(snapshot = {}) {
  return {
    maximum: finiteNumber(snapshot.maximum),
    ordinary_capacity: finiteNumber(snapshot.ordinary_capacity),
    reserved_capacity: finiteNumber(snapshot.reserved_capacity),
    activity_hidden_by_authority: true,
  };
}

/** @param {unknown} snapshot @param {boolean} activityVisible */
export function publicSecurityAudit(snapshot, activityVisible) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  if (activityVisible) return { ...snapshot };
  const audit = /** @type {Record<string, unknown>} */ (snapshot);
  return {
    enabled: audit.enabled === true,
    healthy: audit.healthy === true,
    chain_verified: audit.chain_verified === true,
    persistence: typeof audit.persistence === "string" ? audit.persistence : null,
    worker_ready: audit.worker_ready === true,
    activity_hidden_by_authority: true,
  };
}

/** @param {unknown} status @param {boolean} activityVisible */
export function publicDeviceRootStatus(status, activityVisible) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  if (activityVisible) return { ...status };
  const { key_id: _keyId, ...publicStatus } = /** @type {Record<string, unknown>} */ (status);
  return {
    ...publicStatus,
    key_id_hidden_by_authority: true,
  };
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
/** @param {Record<string, unknown>} info @param {string} [detail] */
export function projectRuntimeInfo(info, detail = "full") {
  if (detail !== "summary") return info;
  const runtime = record(info.runtime);
  const delivery = record(info.tool_delivery);
  const policy = record(info.policy);
  return {
    detail: "summary",
    name: info.name,
    protocol_version: info.protocol_version,
    workspace: info.workspace,
    workspace_name: info.workspace_name,
    policy,
    ...(info.authority_delta ? { authority_delta: info.authority_delta } : {}),
    ...(info.schema_drift ? { schema_drift: info.schema_drift } : {}),
    tool_delivery: {
      effective_tool_count: delivery.effective_tool_count ?? 0,
      daemon_advertised_tool_count: delivery.daemon_advertised_tool_count ?? 0,
      tool_schema_generation: delivery.tool_schema_generation ?? null,
      discovery_ttl_ms: delivery.discovery_ttl_ms ?? null,
      tool_list_ttl_ms: delivery.tool_list_ttl_ms ?? null,
      host_turn_deadline_observable: false,
      managed_jobs_detached_from_mcp_response: delivery.managed_jobs_detached_from_mcp_response === true,
      host_exposed_tools_known_to_server: false,
      host_may_expose_subset: true,
    },
    runtime: {
      lifecycle: runtime.lifecycle ?? null,
      relay: compactRuntimeRelay(runtime.relay),
      processes: compactProcesses(runtime.processes),
      process_sessions: compactCapacity(runtime.process_sessions),
      managed_jobs: compactCapacity(runtime.managed_jobs),
    },
  };
}

/** @param {unknown} value */
function compactProcesses(value) {
  const source = record(value);
  if (source.activity_hidden_by_authority === true) return { activity_hidden_by_authority: true };
  return {
    active_processes: source.active_processes ?? 0,
    draining_processes: source.draining_processes ?? 0,
  };
}

/** @param {unknown} value */
function compactCapacity(value) {
  const source = record(value);
  const capacity = source.capacity && typeof source.capacity === "object" && !Array.isArray(source.capacity)
    ? record(source.capacity) : null;
  return {
    active: source.active ?? 0,
    retained: source.retained ?? 0,
    maximum: source.maximum ?? 0,
    ...(source.staged === undefined ? {} : { staged: source.staged }),
    ...(capacity ? { capacity: {
      retained_state: capacity.retained_state ?? 0,
      retired_state: capacity.retired_state ?? 0,
      retired_unreadable: capacity.retired_unreadable ?? 0,
    } } : {}),
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value */
export function compactRuntimeRelay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const relay = /** @type {Record<string, unknown>} */ (value);
  return {
    authenticated: relay.authenticated === true,
    ready: relay.ready === true,
    closed: relay.closed === true,
    transport: relay.transport ?? null,
    network_route: relay.network_route ?? null,
    reconnect_attempt: relay.reconnect_attempt ?? 0,
    outage_active: relay.outage_active === true,
    outage_count: relay.outage_count ?? 0,
    outage_duration_ms: relay.outage_duration_ms ?? 0,
    last_close_category: relay.last_close_category ?? null,
    last_close_code: relay.last_close_code ?? null,
    last_transport_error_class: relay.last_transport_error_class ?? null,
    https_fallback_active: relay.https_fallback_active === true,
    websocket_ready: relay.websocket_ready === true,
    https_fallback_last_takeover_ms: relay.https_fallback_last_takeover_ms ?? 0,
    https_fallback_last_takeover_outage_number: relay.https_fallback_last_takeover_outage_number ?? 0,
  };
}
/**
 * @typedef {object} RuntimeRedactionOptions
 * @property {unknown} error
 * @property {unknown} toolArgs
 * @property {string} workspace
 * @property {string} workspaceInput
 * @property {string} runtimeDir
 * @property {string | undefined} home
 * @property {(value: string) => string} displayPath
 */

/** @param {string} statePath */
export function stateRootFromProfileStatePath(statePath) {
  const absolute = resolve(statePath);
  if (basename(absolute) !== "state.json") throw new Error("local resource state path is invalid");
  const profileDir = dirname(absolute);
  const profilesDir = dirname(profileDir);
  if (basename(profilesDir) !== "profiles") throw new Error("local resource state path is outside the expected profile layout");
  return dirname(profilesDir);
}

/** @param {string} root @param {string} target */
export function assertContainedPath(root, target) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new BridgeError("path_boundary", "path is outside the configured workspace; restart with --unrestricted-paths to allow it", { details: { reason: "outside_workspace" } });
}

export function createRuntimeDir() {
  const rawRoot = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-"));
  const root = realpathSync.native ? realpathSync.native(rawRoot) : realpathSync(rawRoot);
  for (const name of ["home", "tmp", "cache"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

/** @param {unknown} message @param {RuntimeRedactionOptions} options */
export function redactRuntimeErrorMessage(message, {
  error,
  toolArgs,
  workspace,
  workspaceInput,
  runtimeDir,
  home,
  displayPath,
}) {
  let redacted = String(message);
  for (const prefix of equivalentPathPrefixes(workspace, workspaceInput)) redacted = replacePathPrefix(redacted, prefix, ".");
  for (const prefix of equivalentPathPrefixes(runtimeDir)) redacted = replacePathPrefix(redacted, prefix, "<runtime>");
  if (home) redacted = replacePathPrefix(redacted, resolve(home), "<home>");
  for (const candidate of collectToolPathCandidates(error, toolArgs, workspaceInput)) {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspaceInput, candidate);
    const replacement = displayPath(absolute);
    for (const prefix of equivalentPathPrefixes(candidate, absolute)) redacted = replacePathPrefix(redacted, prefix, replacement);
  }
  return redacted;
}

/** @param {unknown} error @param {unknown} toolArgs @param {string} workspace */
function collectToolPathCandidates(error, toolArgs, workspace) {
  /** @type {Set<string>} */
  const candidates = new Set();
  const pathError = error && typeof error === "object"
    ? /** @type {{ path?: unknown, dest?: unknown }} */ (error)
    : {};
  for (const value of [pathError.path, pathError.dest]) {
    if (typeof value === "string" && value) candidates.add(value);
  }
  /** @param {unknown} value @param {string} [key] @param {number} [depth] */
  const visit = (value, key = "", depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/(?:^|[_-])(?:path|cwd|workspace|root|directory|dir)(?:$|[_-])/i.test(key) && value && !value.includes("\0")) candidates.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(/** @type {Record<string, unknown>} */ (value)).slice(0, 128)) {
      visit(child, childKey, depth + 1);
    }
  };
  visit(toolArgs);
  candidates.delete(workspace);
  return [...candidates].sort((left, right) => right.length - left.length);
}

/** @param {...(string | null | undefined)} values */
function equivalentPathPrefixes(...values) {
  const prefixes = new Set(values.filter(Boolean).map((value) => String(value)));
  for (const value of [...prefixes]) {
    if (value.startsWith("/private/")) prefixes.add(value.slice("/private".length));
    else if (value.startsWith("/") && ["/var/", "/tmp/", "/etc/"].some((prefix) => value.startsWith(prefix))) prefixes.add(`/private${value}`);
  }
  return [...prefixes].sort((left, right) => right.length - left.length);
}

/** @param {string} message @param {string} pathValue @param {string} replacement */
function replacePathPrefix(message, pathValue, replacement) {
  if (!pathValue) return message;
  return message.split(pathValue).join(replacement);
}
/** @param {any} runtime @param {any} message @param {Record<string, unknown>} [relayContext] @returns {boolean} */
export function handleRuntimeRelayAcknowledgement(runtime, message, relayContext = {}) {
  if (message.type === "tool_result_ack") {
    if (!isRelayReadyContext(relayContext, runtime.relay)
        || typeof message.id !== "string"
        || !/^call_[A-Za-z0-9_-]{8,240}$/.test(message.id)) {
      runtime.handleRelayProtocolViolation("invalid_tool_result_ack");
      return true;
    }
    runtime.relayCallRecovery.acknowledge(message.id);
    return true;
  }
  if (message.type !== "daemon_draining_ack") return false;
  return handleRuntimeRelayShutdownAck(runtime, message, isRelayReadyContext(relayContext, runtime.relay));
}
/** @typedef {{provider?: unknown}} DeviceIdentitySummaryInput */
/** @typedef {{url?: unknown, mcpServerUrl?: unknown, name?: unknown, deviceIdentity?: DeviceIdentitySummaryInput, pendingDeviceIdentity?: unknown, previousDeviceIdentities?: unknown[], oauthTokenVersion?: unknown}} WorkerSummaryInput */

/** @param {{schemaVersion?: unknown, policy?: Record<string, unknown>, worker?: WorkerSummaryInput, resources?: Record<string, unknown>}} state */
export function supportStateProjection(state) {
  const worker = state?.worker && typeof state.worker === "object" ? state.worker : {};
  const currentIdentity = worker.deviceIdentity && typeof worker.deviceIdentity === "object" ? worker.deviceIdentity : null;
  const previous = Array.isArray(worker.previousDeviceIdentities) ? worker.previousDeviceIdentities : [];
  const resources = state?.resources && typeof state.resources === "object" && !Array.isArray(state.resources) ? state.resources : {};
  const policy = state?.policy && typeof state.policy === "object" ? state.policy : {};
  return {
    schema_version: Number.isSafeInteger(state?.schemaVersion) ? state.schemaVersion : null,
    policy: {
      profile: typeof policy.profile === "string" ? policy.profile : null,
      origin: typeof policy.origin === "string" ? policy.origin : null,
      revision: Number.isSafeInteger(policy.revision) ? policy.revision : null,
    },
    worker: {
      configured: Boolean(worker.url || worker.mcpServerUrl || worker.name || currentIdentity),
      endpoint_configured: Boolean(worker.url || worker.mcpServerUrl),
      oauth_token_version_configured: Boolean(worker.oauthTokenVersion),
      device_root_provider: currentIdentity ? String(currentIdentity.provider || "portable-jwk-v1") : null,
      pending_device_root: Boolean(worker.pendingDeviceIdentity),
      retired_device_root_count: previous.length,
    },
    resource_count: Object.keys(resources).length,
  };
}
const DEFAULT_WARNING_INTERVAL_MS = 60_000;

/**
 * @param {{ event?: (...args: any[]) => void }} [logger]
 * @param {{ now?: () => number, intervalMs?: number }} [options]
 */
export function createSecurityAuditFailureReporter(logger, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_WARNING_INTERVAL_MS);
  /** @type {Map<string, { lastAt: number, suppressed: number }>} */
  const state = new Map();
  return {
    /**
     * @param {string} event
     * @param {Record<string, unknown>} [fields]
     * @param {string} [message]
     */
    report(event, fields, message) {
      if (typeof logger?.event !== "function") return false;
      const key = String(event || "security.audit.failure");
      const current = Number(now()) || 0;
      const previous = state.get(key);
      if (previous && current - previous.lastAt < intervalMs) {
        previous.suppressed += 1;
        return false;
      }
      const suppressed = previous?.suppressed || 0;
      state.set(key, { lastAt: current, suppressed: 0 });
      logger.event("warn", key, {
        ...(fields && typeof fields === "object" ? fields : {}),
        ...(suppressed > 0 ? { suppressed } : {}),
      }, message);
      return true;
    },
  };
}
export const DOCTOR_RUNTIME_SCOPE = Object.freeze({
  running_service_process_inspected: false,
  remote_relay_inspected: false,
  reason: "doctor uses an isolated local runtime; inspect authenticated server_info.daemon.relay_transport for the running service relay",
});

/**
 * @param {Record<string, any>} [check]
 * @returns {{ name: string, ok: boolean, applicable: boolean, detail: string }}
 */
export function doctorRuntimeCheckProjection(check = {}) {
  const layer = String(check.layer || "unknown");
  const skipped = check.skipped === true;
  const detail = skipped && layer === "remote-relay"
    ? "not inspected (doctor uses an isolated local runtime; inspect authenticated server_info.daemon.relay_transport)"
    : skipped
      ? `skipped (${check.error_class || "not applicable"})`
      : check.ok === true
        ? "ok"
        : String(check.error_class || "failed");
  return {
    name: `runtime:${layer}`,
    ok: skipped || check.ok === true,
    applicable: !skipped,
    detail,
  };
}
