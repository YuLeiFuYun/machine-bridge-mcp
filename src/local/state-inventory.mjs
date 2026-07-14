import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { activeManagedJobs } from "./managed-jobs.mjs";
import { inspectProcessInstance } from "./process-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { STATE_SCHEMA_VERSION, expandHome, readDaemonLockOwner, resolveWorkspace } from "./state.mjs";

const PROFILE_NAME = /^[a-f0-9]{24}$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export function knownWorkerNames(stateRoot) {
  const profiles = profilesDirectory(stateRoot);
  if (!existsSync(profiles)) return [];
  const names = new Set();
  for (const entry of profileDirectories(profiles)) {
    const profileDir = resolve(profiles, entry.name);
    const stateFile = resolve(profileDir, "state.json");
    if (!existsSync(stateFile)) {
      const evidence = readdirSync(profileDir).some((name) => /^state\.json\.corrupt-/.test(name) || name === "daemon.lock");
      if (evidence) throw unreadableWorkerState(entry.name);
      continue;
    }
    let state;
    try {
      state = readStateJson(stateFile);
    } catch {
      throw unreadableWorkerState(entry.name);
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) throw unreadableWorkerState(entry.name);
    const name = String(state?.worker?.name || "");
    if (name && !WORKER_NAME.test(name)) {
      throw new Error(`profile ${entry.name} contains an invalid Worker name; local state was kept for inspection`);
    }
    if (name) names.add(name);
  }
  return [...names];
}

export function knownProfileStates(stateRoot) {
  const canonicalStateRoot = canonicalRoot(stateRoot);
  const profiles = resolve(canonicalStateRoot, "profiles");
  if (!existsSync(profiles)) return [];
  const states = [];
  const seen = new Set();
  for (const entry of profileDirectories(profiles)) {
    const profileDir = resolve(profiles, entry.name);
    const statePath = resolve(profileDir, "state.json");
    const candidates = [];
    if (existsSync(statePath)) {
      try {
        const value = readStateJson(statePath);
        if (typeof value?.workspace?.path === "string") candidates.push(value.workspace.path);
      } catch {
        // A daemon lock may still provide a verified workspace for corrupt state.
      }
    }
    const daemonLock = resolve(profileDir, "daemon.lock");
    const daemonOwner = readDaemonLockOwner(daemonLock);
    if (existsSync(daemonLock) && !daemonOwner) {
      throw new Error(`cannot inspect daemon lock for profile ${entry.name}; service definitions and state were kept`);
    }
    if (typeof daemonOwner?.workspace === "string") candidates.push(daemonOwner.workspace);
    for (const candidate of candidates) {
      try {
        const workspace = resolveWorkspace(candidate);
        if (seen.has(workspace)) break;
        states.push({
          schemaVersion: STATE_SCHEMA_VERSION,
          workspace: { path: workspace, hash: entry.name },
          paths: { stateRoot: canonicalStateRoot, profileDir, statePath },
        });
        seen.add(workspace);
        break;
      } catch {
        // Ignore an invalid historical candidate and try the remaining evidence.
      }
    }
  }
  return states;
}

export function activeStateJobs(stateRoot) {
  const profiles = profilesDirectory(stateRoot);
  if (!existsSync(profiles)) return [];
  const active = [];
  for (const profile of profileDirectories(profiles)) {
    for (const job of activeManagedJobs(resolve(profiles, profile.name, "jobs"))) {
      active.push({ profile: profile.name, ...job });
    }
  }
  return active;
}

export function activeStateLocks(stateRoot) {
  const profiles = profilesDirectory(stateRoot);
  if (!existsSync(profiles)) return [];
  const active = [];
  for (const profile of profileDirectories(profiles)) {
    for (const [kind, name] of [["daemon", "daemon.lock"], ["startup", "startup.lock"]]) {
      const lockPath = resolve(profiles, profile.name, name);
      if (!existsSync(lockPath)) continue;
      const owner = readDaemonLockOwner(lockPath);
      if (!owner) {
        active.push({ kind, pid: null, path: lockPath, reason: "invalid_or_unreadable_lock" });
        continue;
      }
      const maxAgeMs = kind === "startup" ? 2 * 60 * 60 * 1000 : Number.POSITIVE_INFINITY;
      const identity = inspectProcessInstance(owner, { maxAgeMs });
      if (identity.current || (identity.alive && !identity.reclaimable)) {
        active.push({ kind, pid: owner.pid, path: lockPath, reason: identity.reason });
      }
    }
  }
  return active;
}

function profilesDirectory(stateRoot) {
  return resolve(canonicalRoot(stateRoot), "profiles");
}

function canonicalRoot(stateRoot) {
  const expanded = resolve(expandHome(stateRoot));
  if (!existsSync(expanded)) return expanded;
  return realpathSync.native ? realpathSync.native(expanded) : realpathSync(expanded);
}

function profileDirectories(profiles) {
  return readdirSync(profiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name));
}

function readStateJson(path) {
  return JSON.parse(readBoundedRegularFileSync(path, MAX_STATE_BYTES).toString("utf8"));
}

function unreadableWorkerState(profile) {
  return new Error(`cannot determine deployed Worker from profile ${profile}; local state was kept for inspection`);
}
