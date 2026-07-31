// @ts-check

import { inspectWorkspaceDaemon } from "./daemon-process.mjs";
import { loadCommittedServiceOwner } from "./service-owner.mjs";
import { autostartStatus, restartAutostart, startAutostart, stopAutostart } from "./service.mjs";
import { loadState } from "./state.mjs";
import { readyOwnedDaemon, waitForOwnedServiceDaemon } from "./service-runtime-convergence.mjs";
export { waitForOwnedServiceDaemon } from "./service-runtime-convergence.mjs";

/** @typedef {{ status: string, workspace: string, stateRoot: string, entryScript: string, version: string }} ServiceOwner */
/** @typedef {Record<string, unknown> & { ok?: boolean, active?: boolean | null, provider?: string, reason?: string, restarted?: boolean }} ProviderResult */
/** @typedef {Record<string, unknown> & { alive?: boolean, verified_service_daemon?: boolean, mode?: string, startup_readiness_verified?: boolean, identity_reason?: string, pid?: number | null }} DaemonStatus */
/** @typedef {{ expectedVersion: string, expectedEntryScript: string }} DaemonExpectation */
/** @typedef {{ owner?: ServiceOwner, ownerOptions?: Record<string, unknown>, loadOwner?: (options: Record<string, unknown>) => ServiceOwner | null, loadState?: (workspace: string, options: { stateDir: string }) => object, inspectDaemon?: (state: object, expectation: DaemonExpectation) => DaemonStatus, readProvider?: () => ProviderResult | Promise<ProviderResult>, mutateProvider?: (options: { logger?: Console }) => ProviderResult | Promise<ProviderResult>, stopProvider?: (options: { logger?: Console }) => ProviderResult | Promise<ProviderResult>, logger?: Console, attempts?: number, delayMs?: number, sleep?: (milliseconds: number) => Promise<void>, operation?: "start" | "restart" }} OwnedRuntimeOptions */

/** @param {OwnedRuntimeOptions} [options] */
export async function startOwnedServiceRuntime(options = {}) {
  return convergeOwnedServiceRuntime({
    ...options, operation: "start",
    mutateProvider: options.mutateProvider || startAutostart,
  });
}

/** @param {OwnedRuntimeOptions} [options] */
export async function restartOwnedServiceRuntime(options = {}) {
  return convergeOwnedServiceRuntime({
    ...options, operation: "restart",
    mutateProvider: options.mutateProvider || restartAutostart,
  });
}

/** @param {OwnedRuntimeOptions} [options] */
export async function convergeOwnedServiceRuntime(options = {}) {
  const loadOwner = options.loadOwner === undefined ? loadCommittedServiceOwner : options.loadOwner;
  const loadOwnerState = options.loadState === undefined ? loadState : options.loadState;
  const inspectDaemon = options.inspectDaemon === undefined ? inspectWorkspaceDaemon : options.inspectDaemon;
  const readProvider = options.readProvider === undefined ? autostartStatus : options.readProvider;
  const mutateProvider = options.mutateProvider;
  const stopProvider = options.stopProvider === undefined ? stopAutostart : options.stopProvider;
  for (const [name, value] of Object.entries({ loadOwner, loadOwnerState, inspectDaemon, readProvider, stopProvider })) {
    if (typeof value !== "function") throw new TypeError(`owned service runtime requires ${name}`);
  }
  if (typeof mutateProvider !== "function") throw new TypeError("owned service runtime requires mutateProvider");
  const owner = options.owner || loadOwner(options.ownerOptions || {});
  if (!owner) throw new Error("machine service owner is unavailable; reinstall the service before starting it");
  const state = loadOwnerState(owner.workspace, { stateDir: owner.stateRoot });
  /** @returns {DaemonStatus} */
  const inspect = () => inspectDaemon(state, {
    expectedVersion: owner.version,
    expectedEntryScript: owner.entryScript,
  });
  const providerBefore = await readProvider();
  if (typeof providerBefore?.active !== "boolean") {
    throw new Error("machine service provider activity could not be verified before mutation");
  }
  const daemonBefore = inspect();
  assertStartOwnership(providerBefore, daemonBefore);
  const restarting = options.operation === "restart";
  if (!restarting && providerBefore.active === true && readyOwnedDaemon(daemonBefore)) {
    return { ok: true, active: true, already_running: true, reason: "already_running",
      provider: providerBefore.provider, daemon: daemonBefore, service_owner: ownerSummary(owner) };
  }
  const providerResult = await mutateProvider({ logger: options.logger });
  if (providerResult?.ok !== true || providerResult.active !== true) return providerResult;
  if (restarting && providerBefore.active === true && providerResult.restarted !== true) {
    return { ...providerResult, ok: false, reason: providerResult.reason || "restart_not_verified",
      daemon: daemonBefore, service_owner: ownerSummary(owner) };
  }
  const convergence = await waitForOwnedServiceDaemon({
    inspectDaemon: inspect, attempts: options.attempts, delayMs: options.delayMs, sleep: options.sleep,
    replacementPid: restarting && providerBefore.active === true ? daemonBefore.pid : null,
  });
  if (convergence.ok) {
    return { ...providerResult, ok: true, active: true, daemon: convergence.daemon,
      service_owner: ownerSummary(owner), readiness_attempts: convergence.attempts };
  }
  const providerStop = await stopProvider({ logger: options.logger });
  const providerInactive = providerStop?.ok === true && providerStop.active === false;
  return {
    ok: false,
    active: providerStop?.active === true ? true : providerStop?.active === false ? false : null,
    provider: providerResult.provider || providerStop?.provider || "unknown",
    reason: providerInactive ? convergence.reason : `${convergence.reason}_provider_stop_unverified`,
    daemon: convergence.daemon,
    provider_start: providerResult,
    provider_stop: providerStop,
    service_owner: ownerSummary(owner),
  };
}

/** @param {ProviderResult} provider @param {DaemonStatus} daemon */
function assertStartOwnership(provider, daemon) {
  if (!daemon?.alive) return;
  if (daemon.verified_service_daemon !== true || daemon.mode !== "service") {
    throw new Error(`refusing to mutate the machine service while its owner has a ${daemon.identity_reason || daemon.mode || "unverified"} daemon`);
  }
  if (provider.active !== true) {
    throw new Error("the machine service owner has an orphaned service daemon while the provider is inactive; stop it explicitly before retrying");
  }
}

/** @param {ServiceOwner} owner */
function ownerSummary(owner) {
  return { status: owner.status, version: owner.version };
}
