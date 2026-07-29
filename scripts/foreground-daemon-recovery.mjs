import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { inspectProcessInstance, processCommandLine, splitProcessCommandLine } from "../src/local/process-identity.mjs";
import {
  daemonLockPathForState, loadState, readDaemonLockOwner, resolveWorkspace, selectedWorkspace,
} from "../src/local/state.mjs";

const FOREGROUND_PID = /foreground daemon is active \(pid (\d+)\)/i;

export function discoverForegroundDaemonRecovery({ output, stateRoot, workspace = "", dependencies = {} } = {}) {
  const pid = foregroundPid(output);
  if (!pid || typeof stateRoot !== "string" || !stateRoot) return null;
  const selectWorkspace = dependencies.selectedWorkspace || selectedWorkspace;
  const resolve = dependencies.resolveWorkspace || resolveWorkspace;
  const load = dependencies.loadState || loadState;
  const readOwner = dependencies.readDaemonOwner || readDaemonLockOwner;
  const lockPath = dependencies.daemonLockPathForState || daemonLockPathForState;
  const inspect = dependencies.inspectProcessInstance || inspectProcessInstance;
  const readCommand = dependencies.processCommandLine || processCommandLine;
  const splitCommand = dependencies.splitProcessCommandLine || splitProcessCommandLine;
  const canonical = dependencies.realpathSync || realpathSync;
  const fileInfo = dependencies.statSync || statSync;
  const readFile = dependencies.readFileSync || readFileSync;
  let targetWorkspace;
  let canonicalStateRoot;
  let state;
  let owner;
  try {
    targetWorkspace = resolve(workspace || selectWorkspace(stateRoot));
    canonicalStateRoot = canonical(path.resolve(stateRoot));
    state = load(targetWorkspace, { stateDir: canonicalStateRoot });
    owner = readOwner(lockPath(state));
  } catch {
    return null;
  }
  if (Number(owner?.pid) !== pid || owner?.mode !== "foreground" || owner?.purpose !== "daemon") return null;
  if (inspect(owner)?.current !== true) return null;
  if (!sameCanonical(owner.workspace, targetWorkspace, canonical)) return null;
  let entry;
  let argv;
  try {
    entry = canonical(String(owner.entryScript || ""));
    if (!fileInfo(entry).isFile()) return null;
    argv = splitCommand(readCommand(pid));
  } catch {
    return null;
  }
  const entryIndex = argv.findIndex(value => sameCanonical(value, entry, canonical));
  if (entryIndex < 0 || argv[entryIndex + 1] !== "start" || argv.includes("--daemon-only")) return null;
  const commandWorkspace = commandFlagValue(argv, "--workspace");
  const commandStateRoot = commandFlagValue(argv, "--state-dir");
  if (!sameCanonical(commandWorkspace, targetWorkspace, canonical)
      || !sameCanonical(commandStateRoot, canonicalStateRoot, canonical)) return null;
  const packageRoot = path.dirname(path.dirname(entry));
  let pkg;
  try {
    pkg = JSON.parse(readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (pkg?.name !== "machine-bridge-mcp" || pkg.version !== owner.version) return null;
  if (!["machine-mcp", "machine-mcp.mjs"].includes(path.basename(entry))) return null;
  return { pid, cli: entry, version: owner.version, workspace: targetWorkspace, stateRoot: canonicalStateRoot };
}

export function foregroundPid(output) {
  const match = FOREGROUND_PID.exec(String(output || ""));
  const pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function commandFlagValue(argv, name) {
  const exact = argv.find(value => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : "";
}

function sameCanonical(left, right, canonical) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  try {
    const a = canonical(path.resolve(left));
    const b = canonical(path.resolve(right));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
