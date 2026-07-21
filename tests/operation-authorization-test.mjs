import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import catalog from "../src/shared/tool-catalog.json" with { type: "json" };
import {
  OperationAuthorizer,
  approvePendingOperation,
  classifyOperation,
  grantOperationLease,
  listOperationApprovals,
  parseApprovalDuration,
  revokeOperationLease,
} from "../src/local/operation-authorization.mjs";
import { reviewedOperationToolNames } from "../src/local/operation-risk.mjs";
import { withOperationStateLock } from "../src/local/operation-state-lock.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-approval-test-"));
const workspace = path.join(root, "workspace");
const approvalRoot = path.join(root, "state");
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, "README.md"), "ok\n");
const sensitive = path.join(root, ".ssh", "id_test");
mkdirSync(path.dirname(sensitive), { recursive: true });
writeFileSync(sensitive, "synthetic\n", { mode: 0o600 });

const accountId = `acct_${"a".repeat(32)}`;
const clientId = `mcp_client_${"b".repeat(43)}`;
const otherClientId = `mcp_client_${"c".repeat(43)}`;
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
  });

  const ownerShell = await authorizer.authorize(operation("exec_command", { command: "printf owner" }, clientId, "owner"));
  assert(ownerShell.source === "authenticated-owner", "authenticated owner was forced through a local approval lease");
  assert(listOperationApprovals(approvalRoot, now).pending.length === 0, "owner bypass created a pending approval");

  const automatic = await authorizer.authorize(operation("write_file", { path: "safe.txt", content: "safe" }, clientId));
  assert(automatic.source === "automatic", "workspace write did not remain interruption-free");
  const browserReadDenied = await rejected(() => authorizer.authorize(operation("browser_list_tabs", {}, clientId)));
  assert(browserReadDenied.details?.scope === "browser-session", "existing-profile browser metadata bypassed the session boundary");
  const browserPending = listOperationApprovals(approvalRoot, now).pending.find((entry) => entry.scopes.includes("browser-session"));
  assert(browserPending, "browser-session approval request was not persisted");
  const browserLease = await approvePendingOperation(approvalRoot, browserPending.id, "1h", now);
  const navigation = await authorizer.authorize(operation("browser_action", { action: "navigate", url: "https://example.com" }, clientId));
  assert(navigation.leaseId === browserLease.id, "browser-session lease did not cover navigation");
  const formFill = await authorizer.authorize(operation("browser_fill_form", { fields: [{ selector: { id: "name" }, value: "test" }] }, clientId));
  assert(formFill.leaseId === browserLease.id, "browser-session lease did not cover non-submitting form preparation");

  const shellDenied = await rejected(() => authorizer.authorize(operation("exec_command", { command: "printf test" }, clientId)));
  assert(shellDenied.code === "authorization_denied", "remote shell was not stopped at the local approval boundary");
  assert(shellDenied.details?.reason === "local_approval_required", "approval denial omitted its stable reason");
  const pending = listOperationApprovals(approvalRoot, now);
  assert(pending.pending.length === 1 && pending.pending[0].scopes.join(",") === "shell", "shell approval request was not persisted");
  if (process.platform !== "win32") assert(statSync(path.join(approvalRoot, "operation-pending.json")).mode.toString(8).endsWith("600"), "pending approval state is not owner-only");

  await assertRejects(
    () => approvePendingOperation(approvalRoot, pending.pending[0].id, "2h", now, "external-write"),
    "pending approval allowed arbitrary scope substitution",
  );
  const lease = await approvePendingOperation(approvalRoot, pending.pending[0].id, "2h", now);
  assert(lease.account_id === accountId && lease.client_id === clientId, "approved lease lost authenticated identity binding");
  assert(listOperationApprovals(approvalRoot, now).pending.length === 0, "approved request remained pending");
  if (process.platform !== "win32") assert(statSync(path.join(approvalRoot, "operation-leases.json")).mode.toString(8).endsWith("600"), "capability lease state is not owner-only");
  const shellAllowed = await authorizer.authorize(operation("exec_command", { command: "printf second" }, clientId));
  assert(shellAllowed.source === "lease" && shellAllowed.leaseId === lease.id, "active shell lease did not authorize subsequent commands");

  const otherClientDenied = await rejected(() => authorizer.authorize(operation("exec_command", { command: "printf other" }, otherClientId)));
  assert(otherClientDenied.code === "authorization_denied", "capability lease leaked to another OAuth client");

  const browserSubmitAllowed = await authorizer.authorize(operation("browser_fill_form", { fields: [{ selector: { id: "x" }, value: "y" }], submit: true }, clientId));
  assert(browserSubmitAllowed.leaseId === browserLease.id, "browser-session lease did not cover form submission");
  const uploadDenied = await rejected(() => authorizer.authorize(operation("browser_upload_files", { resources: ["artifact"] }, clientId)));
  assert(uploadDenied.details?.scope === "data-export", "browser upload used the wrong missing approval scope");
  assert(uploadDenied.details?.required_scopes?.join(",") === "browser-session,data-export", "browser upload did not require both profile access and data export");
  const exportPending = listOperationApprovals(approvalRoot, now).pending.find((entry) => entry.tool === "browser_upload_files");
  const exportLease = await approvePendingOperation(approvalRoot, exportPending.id, "1h", now);
  const uploadAllowed = await authorizer.authorize(operation("browser_upload_files", { resources: ["artifact"] }, clientId));
  assert(uploadAllowed.leaseIds.includes(browserLease.id) && uploadAllowed.leaseIds.includes(exportLease.id), "compound browser authorization did not combine independent scoped leases");
  await revokeOperationLease(approvalRoot, exportLease.id, now);

  const hookWrite = await classifyOperation("write_file", { path: ".git/hooks/pre-commit", content: "#!/bin/sh" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(hookWrite?.scopes.includes("sensitive-write"), "workspace-contained Git hook write bypassed the persistence boundary");
  const gitConfigWrite = await classifyOperation("write_file", { path: ".git/config", content: "[core]" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(gitConfigWrite?.scopes.includes("sensitive-write"), "repository Git configuration bypassed the persistence boundary");
  const envWrite = await classifyOperation("apply_patch", { patch: "*** Add File: .env.local\n+SECRET=value" }, { workspace });
  assert(envWrite?.scopes.includes("sensitive-write"), "workspace-contained environment write bypassed the sensitive-write boundary");
  const moveOutside = await classifyOperation("apply_patch", {
    patch: "*** Update File: safe.txt\n*** Move to: ../moved-outside.txt\n@@\n-old\n+new",
  }, { workspace });
  assert(moveOutside?.scopes.includes("external-write"), "patch move target bypassed the external-write boundary");
  const moveSensitive = await classifyOperation("apply_patch", {
    patch: "*** Update File: safe.txt\n*** Move to: .git/hooks/pre-commit\n@@\n-old\n+new",
  }, { workspace });
  assert(moveSensitive?.scopes.includes("sensitive-write"), "patch move target bypassed the sensitive-write boundary");
  const exampleWrite = await classifyOperation("write_file", { path: ".env.example", content: "KEY=placeholder" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(exampleWrite === null, "non-secret environment example unexpectedly required a lease");

  const outsideWrite = await classifyOperation("write_file", { path: path.join(root, "outside.txt"), content: "x" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(outsideWrite?.scopes.includes("external-write"), "write outside the workspace was not classified");
  const outsideRead = await classifyOperation("view_image", { path: path.join(root, "ordinary.png") }, {
    workspace,
    resolveExistingPath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(outsideRead?.scopes.includes("external-read"), "ordinary read outside the workspace was not classified");
  const sensitiveRead = await classifyOperation("read_file", { path: sensitive }, {
    workspace,
    resolveExistingPath: async (value) => path.resolve(workspace, String(value)),
  });
  assert(sensitiveRead?.scopes.join(",") === "external-read,sensitive-read", "external credential-sensitive read did not require both boundaries");

  const outsideDirectory = path.join(root, "outside-directory");
  mkdirSync(outsideDirectory);
  const linkedOutside = path.join(workspace, "linked-outside");
  symlinkSync(outsideDirectory, linkedOutside, process.platform === "win32" ? "junction" : "dir");
  const symlinkPatch = await classifyOperation("apply_patch", {
    patch: "*** Add File: linked-outside/escaped.txt\n+escaped",
  }, { workspace, resolveWritePath: canonicalWritePath });
  assert(symlinkPatch?.scopes.includes("external-write"), "patch through a workspace symlink bypassed canonical external-write classification");

  const closeTabAllowed = await authorizer.authorize(operation("browser_manage_tabs", { action: "close", tab_id: 1 }, clientId));
  assert(closeTabAllowed.leaseId === browserLease.id, "browser-session lease did not cover closing a tab");
  const resourceInputDenied = await rejected(() => authorizer.authorize(operation("browser_action", {
    action: "fill",
    tab_id: 1,
    value_resource: "private-value",
  }, clientId)));
  assert(resourceInputDenied.details?.scope === "data-export", "registered resource browser input bypassed the data-export boundary");
  assert(resourceInputDenied.details?.required_scopes?.join(",") === "browser-session,data-export", "registered resource browser input lost its browser-session requirement");
  const cancelJobDenied = await rejected(() => authorizer.authorize(operation("cancel_job", { job_id: `job_${"j".repeat(24)}` }, clientId)));
  assert(cancelJobDenied.details?.scope === "persistent-job", "managed-job cancellation bypassed transaction authorization");
  const readJobDenied = await rejected(() => authorizer.authorize(operation("read_job", { job_id: `job_${"j".repeat(24)}` }, clientId)));
  assert(readJobDenied.details?.scope === "persistent-job", "managed-job output bypassed transaction authorization");
  const readProcessAllowed = await authorizer.authorize(operation("read_process", { session_id: `proc_${"p".repeat(24)}` }, clientId));
  assert(readProcessAllowed.leaseId === lease.id, "shell lease did not cover process output continuation");
  const pairBrowserAllowed = await authorizer.authorize(operation("pair_browser_extension", { open: false }, clientId));
  assert(pairBrowserAllowed.leaseId === browserLease.id, "browser-session lease did not cover extension pairing");

  const appLease = await grantOperationLease(approvalRoot, {
    accountId,
    clientId: otherClientId,
    scope: "application-control",
    duration: "30m",
  }, now);
  const appResourceDenied = await rejected(() => authorizer.authorize(operation("operate_local_application", {
    application: "Example",
    action: "set_value",
    value_resource: "private-value",
  }, otherClientId)));
  assert(appResourceDenied.details?.scope === "data-export", "application resource input bypassed the data-export boundary");
  assert(appResourceDenied.details?.required_scopes?.join(",") === "data-export,application-control", "application resource input did not retain both required scopes");
  await revokeOperationLease(approvalRoot, appLease.id, now);

  const fullLease = await grantOperationLease(approvalRoot, {
    accountId,
    clientId,
    scope: "full",
    duration: "30m",
  }, now);
  const appAllowed = await authorizer.authorize(operation("operate_local_application", { application: "Example", action: "click" }, clientId));
  assert(appAllowed.leaseId === fullLease.id, "full lease did not cover a narrower high-impact scope");
  assert(await revokeOperationLease(approvalRoot, fullLease.id, now), "active full lease could not be revoked");

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
  let concurrentGrantSettled = false;
  const concurrentGrant = grantOperationLease(approvalRoot, {
    accountId,
    clientId,
    scope: "external-read",
    duration: "15m",
  }, now).then((value) => { concurrentGrantSettled = true; return value; });
  await delay(75);
  assert(!concurrentGrantSettled, "operation-state mutation ignored the cross-process lock boundary");
  releaseLock();
  await holdLock;
  assert(!existsSync(operationLockPath), "operation-state lock remained after release");
  const concurrentLease = await concurrentGrant;
  assert(listOperationApprovals(approvalRoot, now).leases.some((entry) => entry.id === concurrentLease.id), "serialized lease mutation was lost after lock handoff");

  now += (2 * 60 * 60 + 1) * 1000;
  const expired = await rejected(() => authorizer.authorize(operation("exec_command", { command: "printf expired" }, clientId)));
  assert(expired.code === "authorization_denied", "expired shell lease remained usable");

  assert(parseApprovalDuration("15m") === 900, "minute duration was parsed incorrectly");
  assertThrows(() => parseApprovalDuration("9h", ["full"]), "full lease exceeded its maximum duration");

  const leaseFile = path.join(approvalRoot, "operation-leases.json");
  const validLeaseState = JSON.parse(readFileSync(leaseFile, "utf8"));
  validLeaseState.leases.push({ id: `lease_${"z".repeat(24)}`, account_id: "*", client_id: "*", scopes: ["full", "shell"], created_at: 1, expires_at: 2 });
  writeFileSync(leaseFile, `${JSON.stringify(validLeaseState)}\n`, { mode: 0o600 });
  assertThrows(() => listOperationApprovals(approvalRoot, now), "malformed persisted lease was accepted");
  console.log("operation authorization test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function operation(tool, args, activeClientId, role = "operator") {
  return {
    tool,
    args,
    context: { origin: "relay" },
    request: {
      authorization: {
        account_id: accountId,
        account_version: 1,
        client_id: activeClientId,
        role,
      },
    },
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
  try {
    await callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to be rejected");
}

async function assertRejects(callback, message) {
  try {
    await callback();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertThrows(callback, message) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
