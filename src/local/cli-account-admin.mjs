import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountAdminClient, accountRoleNames, generateAccountPassword } from "./account-admin.mjs";
import { createDeviceSessionForRoot } from "./device-root-provider.mjs";
import { loadState, packageRoot } from "./state.mjs";

export function createAccountCommand({ chooseWorkspace, confirm }) {
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("account command requires chooseWorkspace and confirm dependencies");
  }
  return async function accountCommand(args) {
    const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
    const state = loadState(workspace, { stateDir: args.stateDir });
    const client = await accountAdminClient(state);
    const action = String(args._[0] || "list").toLowerCase();
    const result = await performAccountAction({ action, args, client, confirm });
    if (result === null) return;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printAccountResult(action, result);
  };
}

export async function accountAdminClient(state, sessionIdentity = null) {
  if (!state.worker?.url || !state.worker?.deviceIdentity) {
    throw new Error("account administration requires a deployed Worker; run machine-mcp first");
  }
  const identity = sessionIdentity || await createDeviceSessionForRoot(
    state.worker.deviceIdentity,
    state.worker.url,
    "machine-bridge-mcp",
    currentPackageVersion(),
    { profileDir: state.paths.profileDir, reason: "Authorize Machine Bridge account administration" },
  );
  return new AccountAdminClient({ workerUrl: state.worker.url, sessionIdentity: identity });
}

function currentPackageVersion() {
  return String(JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version);
}

async function performAccountAction({ action, args, client, confirm }) {
  if (action === "list") return client.list();
  if (action === "clients") return client.listClients();
  if (action === "revoke-client") {
    const clientId = String(args._[1] || "");
    if (!clientId) throw new Error("account revoke-client requires CLIENT_ID");
    if (!args.yes && !(await confirm(`Revoke OAuth client ${clientId}?`, false))) {
      console.log("Client revocation cancelled.");
      return null;
    }
    return client.removeClient({ clientId });
  }
  if (action === "add") {
    const name = args._[1];
    const role = args._[2];
    if (!name || !role) throw new Error(`account add requires NAME and ROLE (${accountRoleNames().join(", ")})`);
    const password = generateAccountPassword();
    return { ...(await client.create({ name, role, password })), password };
  }
  if (action === "role") {
    const account = await client.find(args._[1]);
    const role = args._[2];
    if (!role) throw new Error(`account role requires NAME_OR_ID and ROLE (${accountRoleNames().join(", ")})`);
    return client.update({ accountId: account.account_id, role });
  }
  if (action === "enable" || action === "disable") {
    const account = await client.find(args._[1]);
    return client.update({ accountId: account.account_id, active: action === "enable" });
  }
  if (action === "rotate-password") {
    const account = await client.find(args._[1]);
    const password = generateAccountPassword();
    return { ...(await client.rotatePassword({ accountId: account.account_id, password })), password };
  }
  if (action === "remove") {
    const account = await client.find(args._[1]);
    if (!args.yes && !(await confirm(`Remove account ${account.name}?`, false))) {
      console.log("Account removal cancelled.");
      return null;
    }
    return client.remove({ accountId: account.account_id });
  }
  throw new Error("Unknown account action. Use list, clients, revoke-client, add, role, enable, disable, rotate-password, or remove.");
}

function printAccountResult(action, result) {
  if (action === "clients") {
    if (!result.clients.length) {
      console.log("No OAuth clients configured.");
      return;
    }
    for (const client of result.clients) {
      console.log(`${client.client_name}\t${client.trusted_role || "untrusted"}\t${client.client_id}\taccess=${client.active_access_tokens} refresh=${client.active_refresh_tokens}`);
    }
    return;
  }
  if (action === "list") {
    if (!result.accounts.length) {
      console.log("No accounts configured.");
      return;
    }
    for (const account of result.accounts) {
      console.log(`${account.name}\t${account.role}\t${account.active ? "active" : "disabled"}\t${account.account_id}`);
    }
    return;
  }
  if (result.account) console.log(`${result.account.name}: ${result.account.role}; ${result.account.active ? "active" : "disabled"}`);
  if (result.password) {
    process.stdout.write(`Password: ${result.password}\n`);
    console.log("Save this password now; it is not stored locally or shown again. Do not share this terminal output.");
  }
  if (result.removed) console.log(action === "revoke-client" ? "OAuth client revoked." : "Account removed.");
}
