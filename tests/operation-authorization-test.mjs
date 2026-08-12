import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import catalog from "../src/shared/tool-catalog.json" with { type: "json" };
import { buildAuthorityContext } from "../src/local/authority-context.mjs";
import { OperationAuthorizer, classifyOperation } from "../src/local/operation-authorization.mjs";
import { reviewedOperationToolNames } from "../src/local/operation-risk.mjs";
import { policyProfile } from "../src/local/policy.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-authority-test-"));
const workspace = path.join(root, "workspace");
const securityStateRoot = path.join(root, "state");
mkdirSync(workspace, { recursive: true });
mkdirSync(securityStateRoot, { recursive: true });
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
    root: securityStateRoot,
    now: () => now,
    resolveExistingPath: async (value) => path.resolve(workspace, String(value)),
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
    protectedRoots: [securityStateRoot],
    auditTargetKey: Buffer.alloc(32, 7),
  });

  const ownerShell = await authorizer.authorize(operation("exec_command", { command: "printf owner" }, "owner"));
  assert(ownerShell.source === "trusted-owner", "owner operation did not remain interruption-free");
  assert(ownerShell.scopes.includes("shell"), "owner operation was not risk-classified");

  const reviewerRead = await authorizer.authorize(operation("read_file", { path: "README.md" }, "reviewer"));
  assert(reviewerRead.source === "role-ceiling", "ordinary reviewer read was not automatic");
  assert(reviewerRead.scopes.length === 0, "ordinary workspace read was misclassified");

  const operatorProcess = await authorizer.authorize(operation("run_process", { argv: ["printf", "ok"] }, "operator"));
  assert(operatorProcess.source === "role-ceiling" && operatorProcess.scopes.includes("shell"), "operator direct process was not allowed inside its role ceiling");
  const operatorPersistentOperation = operation("start_job", {
    steps: [{ argv: ["printf", "ok"] }],
  }, "operator");
  const operatorPersistentJob = await rejected(() => authorizer.authorize(operatorPersistentOperation));
  assert(operatorPersistentJob.details?.reason === "account_role_owner_only_tool_ceiling",
    "operation authorization drifted from the shared owner-only tool contract");
  assert(operatorPersistentOperation.context.operationAuthorization?.allowed === false
      && operatorPersistentOperation.context.operationAuthorization.category === "owner-only tool",
  "owner-only denial lost bounded authorization-attempt evidence for audit");
  const reviewerDiagnostics = await rejected(() => authorizer.authorize(operation("diagnose_runtime", {}, "reviewer")));
  assert(reviewerDiagnostics.details?.reason === "account_role_owner_only_tool_ceiling",
    "automatic-risk classification bypassed the shared owner-only diagnostics contract");

  const reviewerExternalOperation = operation("read_file", { path: outside }, "reviewer");
  const reviewerExternal = await rejected(() => authorizer.authorize(reviewerExternalOperation));
  assert(reviewerExternal.details?.reason === "account_role_path_ceiling", "reviewer external read was not denied by the role path ceiling");
  assert(reviewerExternalOperation.context.operationAuthorization?.allowed === false
      && reviewerExternalOperation.context.operationAuthorization.category !== "ordinary operation"
      && /^[a-f0-9]{64}$/.test(reviewerExternalOperation.context.operationAuthorization.targetHash),
  "external-read denial lost privacy-bounded risk/target evidence for audit");

  const editorExternal = await rejected(() => authorizer.authorize(operation("write_file", { path: outside, content: "x" }, "editor")));
  assert(editorExternal.details?.reason === "account_role_path_ceiling", "editor external write was not denied by the role path ceiling");

  const reviewerSensitive = await rejected(() => authorizer.authorize(operation("read_file", { path: sensitive }, "reviewer")));
  assert(reviewerSensitive.details?.reason === "account_role_path_ceiling" || reviewerSensitive.details?.reason === "account_role_sensitive_ceiling", "reviewer sensitive read was not denied");

  const ownerSensitive = await authorizer.authorize(operation("read_file", { path: sensitive }, "owner"));
  assert(ownerSensitive.scopes.includes("sensitive-read"), "owner sensitive read was not classified");
  const rawSensitive = await classifyOperation("read_file", { path: sensitive }, {
    workspace,
    resolveExistingPath: async (value) => path.resolve(workspace, String(value)),
  });
  const repeatedOwnerSensitive = await authorizer.authorize(operation("read_file", { path: sensitive }, "owner"));
  assert(/^[a-f0-9]{64}$/.test(ownerSensitive.targetHash)
    && ownerSensitive.targetHash === repeatedOwnerSensitive.targetHash
    && ownerSensitive.targetHash !== rawSensitive?.targetHash,
  "persisted audit target fingerprint was not runtime-keyed or stable within one runtime");

  const controlState = path.join(securityStateRoot, "state.json");
  writeFileSync(controlState, "{}\n", { mode: 0o600 });
  const ownerControlPlaneOperation = operation("read_file", { path: controlState }, "owner");
  const ownerControlPlane = await rejected(() => authorizer.authorize(ownerControlPlaneOperation));
  assert(ownerControlPlane.details?.reason === "control_plane_state_protected", "owner path-based file access could export Machine Bridge control-plane state");
  assert(ownerControlPlaneOperation.context.operationAuthorization?.allowed === false
      && /^[a-f0-9]{64}$/.test(ownerControlPlaneOperation.context.operationAuthorization.targetHash),
  "control-plane denial lost its privacy-bounded classified target evidence for audit");

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
  const argvProtectedJob = await classifyOperation("start_job", {
    steps: [{ argv: ["cat", "{{resource:private-value}}", "prefix={{resource:second-value}}"] }],
  }, { workspace });
  assert(argvProtectedJob?.scopes.includes("sensitive-read") && argvProtectedJob.scopes.includes("persistent-job"),
    "managed-job argv resource injection was omitted from the sensitive-data effect classification");
  const operatorProtectedJob = await rejected(() => authorizer.authorize(operation("start_job", {
    steps: [{ argv: ["cat"], stdin_resource: "private-value" }],
  }, "operator")));
  assert(operatorProtectedJob.details?.reason === "account_role_owner_only_tool_ceiling",
    "owner-only managed-job creation did not short-circuit before narrower protected-resource checks");

  const hookWrite = await classifyOperation("write_file", { path: ".git/hooks/pre-commit", content: "#!/bin/sh" }, {
    workspace,
    resolveWritePath: async (value) => path.resolve(workspace, String(value)),
    protectedRoots: [securityStateRoot],
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
