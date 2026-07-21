import {
  OPERATION_APPROVAL_SCOPES,
  approvePendingOperation,
  clearOperationLeases,
  grantOperationLease,
  listOperationApprovals,
  revokeOperationLease,
} from "./operation-authorization.mjs";
import { loadState } from "./state.mjs";

const ACTIONS = new Set(["list", "approve", "grant", "revoke", "clear"]);

export function createApprovalCommand({ chooseWorkspace, confirm }) {
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("approval command requires chooseWorkspace and confirm dependencies");
  }
  return async function approvalCommand(args) {
    const action = String(args._[0] || "list").toLowerCase();
    if (!ACTIONS.has(action)) throw new Error(`Unknown approval action: ${action}`);
    const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
    const state = loadState(workspace, { stateDir: args.stateDir });
    const root = state.paths.profileDir;
    if (action === "list") return renderList(listOperationApprovals(root), args.json === true);
    if (action === "approve") {
      const id = requiredPositional(args, 1, "approval approve requires APPROVAL_ID");
      return renderLease(await approvePendingOperation(
        root,
        id,
        args.duration || (args.full ? "8h" : "1h"),
        Date.now(),
        args.full ? "full" : "",
      ), args.json === true, "Approved");
    }
    if (action === "grant") {
      const scope = requiredPositional(args, 1, "approval grant requires SCOPE");
      if (!OPERATION_APPROVAL_SCOPES.includes(scope)) {
        throw new Error(`approval scope must be one of: ${OPERATION_APPROVAL_SCOPES.join(", ")}`);
      }
      const clientId = String(args.client || "");
      const accountId = String(args.account || "");
      if (!clientId) throw new Error("approval grant requires --client CLIENT_ID; use * only for an intentional all-client lease");
      if (!accountId) throw new Error("approval grant requires --account ACCOUNT_ID; use * only for an intentional all-account lease");
      return renderLease(await grantOperationLease(root, {
        accountId,
        clientId,
        scope,
        duration: args.duration || "1h",
      }), args.json === true, "Granted");
    }
    if (action === "revoke") {
      const id = requiredPositional(args, 1, "approval revoke requires LEASE_ID");
      const removed = await revokeOperationLease(root, id);
      if (args.json) console.log(JSON.stringify({ lease_id: id, revoked: removed }, null, 2));
      else console.log(removed ? `Revoked capability lease: ${id}` : `Capability lease was not active: ${id}`);
      return;
    }
    const approved = await confirm("Revoke all active remote capability leases?", args.yes === true);
    if (!approved) {
      console.log("No capability leases were changed.");
      return;
    }
    await clearOperationLeases(root);
    if (args.json) console.log(JSON.stringify({ cleared: true }, null, 2));
    else console.log("Revoked all active remote capability leases.");
  };
}

function renderList(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.pending.length && !result.leases.length) {
    console.log("No pending approvals or active capability leases.");
    return;
  }
  if (result.pending.length) {
    console.log("Pending approvals:");
    for (const item of result.pending) {
      console.log(`  ${item.id}\t${scopeText(item.scopes)}\t${item.category}\tclient ${shortId(item.client_id)}\texpires ${formatTime(item.expires_at)}`);
    }
  }
  if (result.leases.length) {
    console.log("Active capability leases:");
    for (const item of result.leases) {
      console.log(`  ${item.id}\t${scopeText(item.scopes)}\tclient ${shortId(item.client_id)}\texpires ${formatTime(item.expires_at)}`);
    }
  }
}

function renderLease(lease, json, verb) {
  if (json) {
    console.log(JSON.stringify(lease, null, 2));
    return;
  }
  console.log(`${verb} ${scopeText(lease.scopes)} capability lease for client ${shortId(lease.client_id)} until ${formatTime(lease.expires_at)}.`);
  console.log(`Lease ID: ${lease.id}`);
}

function requiredPositional(args, index, message) {
  const value = String(args._[index] || "");
  if (!value) throw new Error(message);
  return value;
}

function scopeText(scopes) {
  return Array.isArray(scopes) ? scopes.join("+") : "<invalid-scope>";
}

function shortId(value) {
  const text = String(value || "");
  return text === "*" ? "*" : `${text.slice(0, 14)}...${text.slice(-6)}`;
}

function formatTime(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000).toISOString();
}
