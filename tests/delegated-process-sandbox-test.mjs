import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  delegatedProcessCommand,
  delegatedProcessRuntimeDir,
  delegatedProcessIsolationStatus,
  macosDelegatedSandboxProfile,
  macosSandboxAvailable,
  probeMacosDelegatedSandbox,
} from "../src/local/delegated-process-sandbox.mjs";

import { executionEnv } from "../src/local/shell.mjs";
import { acquireProcessResources } from "../src/local/resource-process-admission.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-delegated-sandbox-"));
const workspace = path.join(root, "workspace");
const runtimeDir = path.join(root, "runtime");
mkdirSync(workspace);
mkdirSync(runtimeDir);
writeFileSync(path.join(workspace, "visible.txt"), "workspace-visible\n");
const context = {
  authority: {
    principal: {
      kind: "account",
      accountId: `acct_${"a".repeat(32)}`,
      accountVersion: 1,
      clientId: `mcp_client_${"b".repeat(43)}`,
      familyId: `mcp_family_${"c".repeat(43)}`,
      role: "operator",
    },
  },
};

try {
  const local = delegatedProcessCommand({ command: "printf", args: ["ok"], workspace, runtimeDir, context: {} });
  assert(local.command === "printf" && local.isolation === "owner-or-local-user", "local execution was unnecessarily wrapped");

  const profile = macosDelegatedSandboxProfile({ workspace, runtimeDir });
  const writePaths = [...profile.matchAll(/\(allow file-write\* \(subpath ("(?:\\.|[^"\\])*")\)\)/g)].map((match) => JSON.parse(match[1]));
  assert(writePaths.length === 2 && writePaths.includes(path.resolve(workspace)) && writePaths.includes(path.resolve(runtimeDir)),
    "delegated sandbox writes extend beyond workspace and private runtime directories");
  assert(delegatedProcessRuntimeDir(runtimeDir, {}) === runtimeDir,
    "local execution lost its shared owner runtime");
  assert(delegatedProcessRuntimeDir(runtimeDir, { authority: { principal: { kind: "account", role: "owner" } } }) === runtimeDir,
    "owner execution lost its existing runtime");
  const privateRuntime = delegatedProcessRuntimeDir(runtimeDir, context);
  assert(privateRuntime !== runtimeDir && delegatedProcessRuntimeDir(runtimeDir, context) === privateRuntime,
    "delegated runtime was shared with the owner or changed during the same account session");
  for (const name of ["", "home", "tmp", "cache"]) {
    const info = lstatSync(path.join(privateRuntime, name));
    assert(info.isDirectory() && !info.isSymbolicLink() && (process.platform === "win32" || (info.mode & 0o077) === 0),
      "delegated runtime directory is missing, symbolic, or accessible to other users");
  }
  for (const field of ["accountId", "accountVersion", "clientId", "familyId"]) {
    const other = { authority: { principal: { ...context.authority.principal, [field]: field === "accountVersion" ? 2 : context.authority.principal[field] + "different" } } };
    assert(delegatedProcessRuntimeDir(runtimeDir, other) !== privateRuntime,
      "delegated runtime survived an account/client/family authority change");
  }
  const privateProfile = macosDelegatedSandboxProfile({ workspace, runtimeDir: privateRuntime });
  const writableRoots = [...privateProfile.matchAll(/\(allow file-write\* \(subpath ("(?:\\.|[^"])*")\)\)/g)].map((match) => JSON.parse(match[1]));
  const ownerCache = path.join(runtimeDir, "macos-background-input");
  assert(writableRoots.every((allowed) => {
    const relative = path.relative(allowed, ownerCache);
    return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
  }), "delegated profile retained write permission for the owner native-helper cache");
  if (process.platform !== "win32") {
    const home = path.join(privateRuntime, "home");
    rmSync(home, { recursive: true });
    symlinkSync(workspace, home, "dir");
    let denied = false;
    try { delegatedProcessRuntimeDir(runtimeDir, context); } catch { denied = true; }
    assert(denied, "delegated runtime followed a replaced private HOME directory");
    rmSync(home);
    delegatedProcessRuntimeDir(runtimeDir, context);
  }

  const previousBuildRoot = process.env.AGENT_BUILD_ROOT;
  process.env.AGENT_BUILD_ROOT = path.join(root, "owner-build-cache");
  try {
    const ownerEnvironment = executionEnv(workspace, { fullEnv: true, runtimeDir });
    assert(ownerEnvironment.AGENT_BUILD_ROOT === process.env.AGENT_BUILD_ROOT, "owner build-root configuration changed");
    for (const fullEnv of [false, true]) {
      const env = executionEnv(workspace, { runtimeDir: privateRuntime, fullEnv, delegated: true });
      assert(env.HOME === path.join(privateRuntime, "home") && env.AGENT_BUILD_ROOT === path.join(privateRuntime, "cache", "build"),
        "delegated execution inherited owner HOME or build cache");
      let admissions = 0;
      const coordinator = { async acquire(request) { admissions += 1; return { request, async release() { return true; } }; } };
      for (const [command, args, output] of [
        ["cargo", ["build"], (result) => result.environment.CARGO_TARGET_DIR],
        ["swift", ["build"], (result) => result.args[result.args.indexOf("--scratch-path") + 1]],
        ["xcodebuild", ["build"], (result) => result.args[result.args.indexOf("-derivedDataPath") + 1]],
      ]) {
        const admitted = await acquireProcessResources(coordinator, command, args, env, { cwd: workspace });
        const relative = path.relative(env.AGENT_BUILD_ROOT, output(admitted));
        assert(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
          "automatic compiler output escaped delegated build cache");
      }
      assert(admissions === 3, "delegated builds bypassed machine resource admission");
    }
  } finally {
    if (previousBuildRoot === undefined) delete process.env.AGENT_BUILD_ROOT;
    else process.env.AGENT_BUILD_ROOT = previousBuildRoot;
  }

  const status = delegatedProcessIsolationStatus();
  if (status.available) {
    assert(profile.includes("deny default") && !profile.includes("allow default"), "delegated sandbox is not deny-default");
    assert(status.keychain.includes("behavior probe") && status.residual.includes("not separate OS-user tenancy"), "delegated sandbox overstated Keychain or tenancy isolation");
    const wrapped = delegatedProcessCommand({ command: "/bin/cat", args: [path.join(workspace, "visible.txt")], workspace, runtimeDir, context });
    assert(wrapped.command === "/usr/bin/sandbox-exec" && wrapped.isolation === "macos-sandbox-exec-workspace", "delegated execution did not select the verified macOS sandbox");
  } else {
    let denied = false;
    try { delegatedProcessCommand({ command: "printf", args: ["ok"], workspace, runtimeDir, context }); } catch (error) {
      denied = error?.details?.reason === "delegated_process_isolation_unavailable";
    }
    assert(denied, "delegated execution did not fail closed without a verified sandbox provider");
  }

  const behaviorProbe = ({ spawnSyncProcess }) => probeMacosDelegatedSandbox({ spawnSyncProcess });
  const fakeSpawn = (_command, args, options) => {
    assert(options.timeout === 5_000 && options.killSignal === "SIGKILL",
      "delegated sandbox probe timeout could remain blocked after SIGTERM");
    const argv = args.slice(2);
    if (argv[0] === "/bin/cat" && argv[1]?.endsWith("allowed.txt")) return { status: 0 };
    if (argv[0] === "/bin/sh" && argv[2]?.startsWith("printf allowed > ")) {
      const match = argv[2].match(/> '([^']+)'$/);
      if (!match) throw new Error("allowed-write probe did not quote its destination");
      writeFileSync(match[1], "allowed");
      return { status: 0 };
    }
    return { status: 1 };
  };
  assert(probeMacosDelegatedSandbox({ spawnSyncProcess: fakeSpawn }), "deterministic sandbox behavior probe did not accept the required matrix");
  let globalWriteAttempted = false;
  const globalWriteAllowed = (_command, args, options) => {
    const argv = args.slice(2);
    if (argv[0] === "/bin/sh" && argv[2]?.endsWith("blocked-global-write.txt'")) {
      globalWriteAttempted = true;
      const match = argv[2].match(/> '([^']+)'$/);
      if (!match) throw new Error("global temporary write probe did not quote its destination");
      writeFileSync(match[1], "unexpected");
      return { status: 0 };
    }
    return fakeSpawn(_command, args, options);
  };
  assert(!probeMacosDelegatedSandbox({ spawnSyncProcess: globalWriteAllowed }) && globalWriteAttempted,
    "sandbox probe accepted a provider that writes to unrelated global temporary files");
  assert(macosSandboxAvailable({
    refresh: true,
    platform: "darwin",
    exists: () => true,
    behaviorProbe,
    spawnSync: fakeSpawn,
  }), "successful sandbox behavior probe was not accepted");
  const wrapped = delegatedProcessCommand({ command: "/usr/bin/true", args: [], workspace, runtimeDir, context, platform: "darwin" });
  assert(wrapped.command === "/usr/bin/sandbox-exec", "verified sandbox probe did not enable wrapping");
  const forced = delegatedProcessCommand({ command: "/usr/bin/true", args: [], workspace, runtimeDir, context: {}, platform: "darwin", forceDelegated: true });
  assert(forced.command === "/usr/bin/sandbox-exec" && forced.isolation === "macos-sandbox-exec-workspace",
    "durable delegated execution could bypass sandboxing after the original request context ended");
  assert(!macosSandboxAvailable({
    refresh: true,
    platform: "darwin",
    exists: () => true,
    behaviorProbe: () => false,
  }), "failed sandbox behavior probe was accepted from executable presence alone");
  let forcedDenied = false;
  try { delegatedProcessCommand({ command: "/usr/bin/true", args: [], workspace, runtimeDir, context: {}, platform: "darwin", forceDelegated: true }); }
  catch (error) { forcedDenied = error?.details?.reason === "delegated_process_isolation_unavailable"; }
  assert(forcedDenied, "durable delegated execution did not fail closed after sandbox verification failed");
  macosSandboxAvailable({ refresh: true });

  console.log("delegated process sandbox test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
