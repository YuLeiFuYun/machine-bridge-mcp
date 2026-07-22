import {
  clearOperationLeases,
  listOperationApprovals,
  revokeOperationLease,
} from "./operation-authorization.mjs";
import { loadState } from "./state.mjs";

const ACTIONS = new Set(["list", "revoke", "clear"]);

export function createApprovalCommand({ chooseWorkspace, confirm }) {
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("approval command requires chooseWorkspace and confirm dependencies");
  }
  return async function approvalCommand(args) {
    const action = String(args._[0] || "list").toLowerCase();
    if (!ACTIONS.has(action)) {
      throw new Error("Terminal operation approval was removed. Remote calls run automatically within the account role ceiling; use account management to change trust and approval revoke/clear only to remove legacy leases.");
    }
    const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
    const state = loadState(workspace, { stateDir: args.stateDir });
    const root = state.paths.profileDir;
    if (action === "list") return renderList(listOperationApprovals(root), args.json === true);
    if (action === "revoke") {
      const id = requiredPositional(args, 1, "approval revoke requires LEASE_ID");
      const removed = await revokeOperationLease(root, id);
      if (args.json) console.log(JSON.stringify({ lease_id: id, revoked: removed }, null, 2));
      else console.log(removed ? `Revoked legacy capability lease: ${id}` : `Legacy capability lease was not active: ${id}`);
      return;
    }
    const approved = await confirm("Revoke all legacy remote capability leases?", args.yes === true);
    if (!approved) {
      console.log("No legacy capability leases were changed.");
      return;
    }
    await clearOperationLeases(root);
    if (args.json) console.log(JSON.stringify({ cleared: true }, null, 2));
    else console.log("Revoked all legacy remote capability leases.");
  };
}

function renderList(result, json) {
  if (json) {
    console.log(JSON.stringify({ ...result, runtime_authorization: "automatic-within-role-ceiling" }, null, 2));
    return;
  }
  if (!result.leases.length) {
    console.log("No active legacy capability leases. Runtime authorization is automatic within each account role ceiling.");
    return;
  }
  console.log("Legacy capability leases (not consumed by the current runtime):");
  for (const item of result.leases) {
    console.log(`  ${item.id}\t${scopeText(item.scopes)}\tclient ${shortId(item.client_id)}\texpires ${formatTime(item.expires_at)}`);
  }
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
