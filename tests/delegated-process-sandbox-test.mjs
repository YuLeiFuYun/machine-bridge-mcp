import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  delegatedProcessCommand,
  delegatedProcessIsolationStatus,
  macosDelegatedSandboxProfile,
  macosSandboxAvailable,
  probeMacosDelegatedSandbox,
} from "../src/local/delegated-process-sandbox.mjs";

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

  const status = delegatedProcessIsolationStatus();
  if (status.available) {
    const profile = macosDelegatedSandboxProfile({ workspace, runtimeDir });
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
  const fakeSpawn = (_command, args) => {
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
  assert(macosSandboxAvailable({
    refresh: true,
    platform: "darwin",
    exists: () => true,
    behaviorProbe,
    spawnSync: fakeSpawn,
  }), "successful sandbox behavior probe was not accepted");
  const wrapped = delegatedProcessCommand({ command: "/usr/bin/true", args: [], workspace, runtimeDir, context, platform: "darwin" });
  assert(wrapped.command === "/usr/bin/sandbox-exec", "verified sandbox probe did not enable wrapping");
  assert(!macosSandboxAvailable({
    refresh: true,
    platform: "darwin",
    exists: () => true,
    behaviorProbe: () => false,
  }), "failed sandbox behavior probe was accepted from executable presence alone");
  macosSandboxAvailable({ refresh: true });

  console.log("delegated process sandbox test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
