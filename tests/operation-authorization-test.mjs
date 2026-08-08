import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import catalog from "../src/shared/tool-catalog.json" with { type: "json" };
import { buildAuthorityContext } from "../src/local/authority-context.mjs";
import {
  OperationAuthorizer,
  clearOperationLeases,
  classifyOperation,
  listOperationApprovals,
  revokeOperationLease,
} from "../src/local/operation-authorization.mjs";
import { reviewedOperationToolNames } from "../src/local/operation-risk.mjs";
import { policyProfile } from "../src/local/policy.mjs";
import { withOperationStateLock } from "../src/local/operation-state-lock.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-authority-test-"));
const workspace = path.join(root, "workspace");
const approvalRoot = path.join(root, "state");
mkdirSync(workspace, { recursive: true });
mkdirSync(approvalRoot, { recursive: true });
writeFileSync(path.join(workspace, "README.md"), "ok\n");
const outside = path.join(root, "ordinary.txt");
writeFileSync(outside, "outside\n");
const sensitive = path.join(root, ".ssh", "id_test");
mkdirSync(path.dirname(sensitive), { recursive: true });
writeFileSync(sensitive, "synthetic\n", { mode: 0o600 });

const accountId = `acct_${"a".repeat(32)}`;
const clientId = `mcp_client_${"b".repeat(43)}`;
let now = Date.UTC(2026, 6, 21, 0, 0, 0);

try {
  const catalogNames = new Set(catalog.map((tool) => tool.name));
  const reviewedNames = reviewedOperationToolNames();
  assert(
    [...catalogNames].every((name) => reviewedNames.has(name)) && [...reviewedNames].every((name) => catalogNames.has(name)),
    `operation-risk review coverage drifted: missing=${[...catalogNames].filter((name) => !reviewedNames.has(name)).join(",")} stale=${[...reviewedNames].filter((name) => !catalogNames.has(name)).join(",")}`,
  );

  const authorizer = new OperationAuthorizer({
    workspace,
    root: approvalRoot,
    now: () => now,
    resolveExistingPath: async (value) => path.resolve(workspace, String(value)),
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
    protectedRoots: [approvalRoot],
  });

  const ownerShell = await authorizer.authorize(operation("exec_command", { command: "printf owner" }, "owner"));
  assert(ownerShell.source === "trusted-owner", "owner operation did not remain interruption-free");
  assert(ownerShell.scopes.includes("shell"), "owner operation was not risk-classified");
  assert(listOperationApprovals(approvalRoot, now).pending.length === 0, "runtime authorization created terminal approval state");

  const reviewerRead = await authorizer.authorize(operation("read_file", { path: "README.md" }, "reviewer"));
  assert(reviewerRead.source === "role-ceiling", "ordinary reviewer read was not automatic");
  assert(reviewerRead.scopes.length === 0, "ordinary workspace read was misclassified");

  const operatorProcess = await authorizer.authorize(operation("run_process", { argv: ["printf", "ok"] }, "operator"));
  assert(operatorProcess.source === "role-ceiling" && operatorProcess.scopes.includes("shell"), "operator direct process was not allowed inside its role ceiling");

  const reviewerExternal = await rejected(() => authorizer.authorize(operation("read_file", { path: outside }, "reviewer")));
  assert(reviewerExternal.details?.reason === "account_role_path_ceiling", "reviewer external read was not denied by the role path ceiling");

  const editorExternal = await rejected(() => authorizer.authorize(operation("write_file", { path: outside, content: "x" }, "editor")));
  assert(editorExternal.details?.reason === "account_role_path_ceiling", "editor external write was not denied by the role path ceiling");

  const reviewerSensitive = await rejected(() => authorizer.authorize(operation("read_file", { path: sensitive }, "reviewer")));
  assert(reviewerSensitive.details?.reason === "account_role_path_ceiling" || reviewerSensitive.details?.reason === "account_role_sensitive_ceiling", "reviewer sensitive read was not denied");

  const ownerSensitive = await authorizer.authorize(operation("read_file", { path: sensitive }, "owner"));
  assert(ownerSensitive.scopes.includes("sensitive-read"), "owner sensitive read was not classified");

  const controlState = path.join(approvalRoot, "state.json");
  writeFileSync(controlState, "{}\n", { mode: 0o600 });
  const ownerControlPlane = await rejected(() => authorizer.authorize(operation("read_file", { path: controlState }, "owner")));
  assert(ownerControlPlane.details?.reason === "control_plane_state_protected", "owner path-based file access could export Machine Bridge control-plane state");

  const ownerBrowser = await authorizer.authorize(operation("browser_action", { action: "navigate", url: "https://example.com" }, "owner"));
  assert(ownerBrowser.scopes.includes("browser-session"), "owner browser session was not classified");

  const prototypeTarget = await classifyOperation("exec_command", JSON.parse('{"command":"echo protected","__proto__":"distinct-target"}'));
  const ordinaryTarget = await classifyOperation("exec_command", { command: "echo protected" });
  assert(prototypeTarget?.targetHash !== ordinaryTarget?.targetHash,
    "operation-risk redaction collapsed a prototype-shaped own field out of the audit target hash");

  const protectedJob = await classifyOperation("start_job", {
    steps: [{ argv: ["cat"], stdin_resource: "private-value" }],
  }, { workspace });
  assert(protectedJob.scopes.join(",") === "sensitive-read,persistent-job" || protectedJob.scopes.join(",") === "persistent-job,sensitive-read", "protected job resource use was not classified");
  const operatorProtectedJob = await rejected(() => authorizer.authorize(operation("start_job", {
    steps: [{ argv: ["cat"], stdin_resource: "private-value" }],
  }, "operator")));
  assert(operatorProtectedJob.details?.reason === "account_role_sensitive_ceiling", "operator could use owner-protected resources in a managed job");

  const hookWrite = await classifyOperation("write_file", { path: ".git/hooks/pre-commit", content: "#!/bin/sh" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
    protectedRoots: [approvalRoot],
  });
  assert(hookWrite?.scopes.includes("sensitive-write"), "workspace Git hook write bypassed the persistence boundary");

  const envWrite = await classifyOperation("apply_patch", { patch: "*** Add File: .env.local\n+SECRET=value" }, { workspace });
  assert(envWrite?.scopes.includes("sensitive-write"), "workspace environment write bypassed the sensitive-write boundary");

  const moveOutside = await classifyOperation("apply_patch", {
    patch: "*** Update File: README.md\n*** Move to: ../moved-outside.txt\n@@\n-ok\n+new",
  }, { workspace });
  assert(moveOutside?.scopes.includes("external-write"), "patch move target bypassed the external-write boundary");

  const outsideDirectory = path.join(root, "outside-directory");
  mkdirSync(outsideDirectory);
  const linkedOutside = path.join(workspace, "linked-outside");
  symlinkSync(outsideDirectory, linkedOutside, process.platform === "win32" ? "junction" : "dir");
  const symlinkPatch = await classifyOperation("apply_patch", {
    patch: "*** Add File: linked-outside/escaped.txt\n+escaped",
  }, { workspace, resolveWritePath: canonicalWritePath });
  assert(symlinkPatch?.scopes.includes("external-write"), "patch through a workspace symlink bypassed canonical classification");

  const leaseFile = path.join(approvalRoot, "operation-leases.json");
  const lease = {
    id: `lease_${"l".repeat(24)}`,
    account_id: accountId,
    account_version: 1,
    client_id: clientId,
    scopes: ["shell"],
    created_at: Math.floor(now / 1000),
    expires_at: Math.floor(now / 1000) + 1800,
  };
  writeFileSync(leaseFile, `${JSON.stringify({ schemaVersion: 2, leases: [lease] }, null, 2)}
`, { mode: 0o600 });
  assert(listOperationApprovals(approvalRoot, now).leases.some((entry) => entry.id === lease.id), "legacy lease was not readable for migration cleanup");

  let releaseLock;
  let markLockEntered;
  const lockEntered = new Promise((resolvePromise) => { markLockEntered = resolvePromise; });
  const holdLock = withOperationStateLock(approvalRoot, async () => {
    markLockEntered();
    await new Promise((resolvePromise) => { releaseLock = resolvePromise; });
  });
  await lockEntered;
  const operationLockPath = path.join(approvalRoot, "operation-authorization.lock");
  if (process.platform !== "win32") assert(statSync(operationLockPath).mode.toString(8).endsWith("600"), "operation-state lock is not owner-only");
  let revokeSettled = false;
  const concurrentRevoke = revokeOperationLease(approvalRoot, lease.id, now).then((value) => { revokeSettled = true; return value; });
  await delay(75);
  assert(!revokeSettled, "legacy lease cleanup ignored the cross-process lock");
  releaseLock();
  await holdLock;
  assert(!existsSync(operationLockPath), "operation-state lock remained after release");
  assert(await concurrentRevoke, "legacy lease could not be revoked");

  writeFileSync(leaseFile, `${JSON.stringify({ schemaVersion: 2, leases: [lease] }, null, 2)}
`, { mode: 0o600 });
  await clearOperationLeases(approvalRoot);
  assert(listOperationApprovals(approvalRoot, now).leases.length === 0, "legacy leases were not cleared");

  const validLeaseState = JSON.parse(readFileSync(leaseFile, "utf8"));
  validLeaseState.leases.push({ id: `lease_${"z".repeat(24)}`, account_id: accountId, account_version: 0, client_id: clientId, scopes: ["shell"], created_at: 1, expires_at: 2 });
  writeFileSync(leaseFile, `${JSON.stringify(validLeaseState)}\n`, { mode: 0o600 });
  assertThrows(() => listOperationApprovals(approvalRoot, now), "malformed persisted lease was accepted");

  if (process.platform !== "win32") {
    const leaseTarget = path.join(root, "external-operation-leases.json");
    writeFileSync(leaseTarget, `${JSON.stringify({ schemaVersion: 2, leases: [] })}\n`, { mode: 0o600 });
    unlinkSync(leaseFile);
    symlinkSync(leaseTarget, leaseFile);
    expectThrow(() => listOperationApprovals(approvalRoot, now), "regular file and not a symbolic link");
    unlinkSync(leaseFile);
    writeFileSync(leaseFile, `${JSON.stringify({ schemaVersion: 2, leases: [] })}\n`, { mode: 0o600 });
    const leaseHardLink = path.join(root, "operation-leases-hard-link.json");
    linkSync(leaseFile, leaseHardLink);
    expectThrow(() => listOperationApprovals(approvalRoot, now), "multiple hard links");
    unlinkSync(leaseHardLink);
  }

  console.log("request authority and operation classification test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function operation(tool, args, role, activeClientId = clientId) {
  const authorization = {
    account_id: accountId,
    account_version: 1,
    client_id: activeClientId,
    family_id: `mcp_family_${role.slice(0, 1).repeat(43)}`,
    role,
  };
  const authority = buildAuthorityContext({ authorization, daemonPolicy: policyProfile("full"), origin: "relay" });
  return {
    tool,
    args,
    context: { origin: "relay", authority },
    request: { authorization },
  };
}

async function canonicalWritePath(value) {
  const candidate = path.resolve(workspace, String(value));
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  const suffix = path.relative(ancestor, candidate);
  return suffix ? path.resolve(canonicalAncestor, suffix) : canonicalAncestor;
}

async function rejected(callback) {
  try { await callback(); } catch (error) { return error; }
  throw new Error("expected operation to be rejected");
}

function expectThrow(callback, expected) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected error containing: ${expected}`);
}

function assertThrows(callback, message) {
  try { callback(); } catch { return; }
  throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
