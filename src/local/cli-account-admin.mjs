import { AccountAdminClient, accountRoleNames, generateAccountPassword } from "./account-admin.mjs";
import { loadState } from "./state.mjs";

export function createAccountCommand({ chooseWorkspace, confirm }) {
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("account command requires chooseWorkspace and confirm dependencies");
  }
  return async function accountCommand(args) {
    const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
    const state = loadState(workspace, { stateDir: args.stateDir });
    const client = accountAdminClient(state);
    const action = String(args._[0] || "list").toLowerCase();
    const result = await performAccountAction({ action, args, client, confirm });
    if (result === null) return;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printAccountResult(action, result);
  };
}

export function accountAdminClient(state) {
  if (!state.worker?.url || !state.worker?.accountAdminSecret) {
    throw new Error("account administration requires a deployed Worker; run machine-mcp first");
  }
  return new AccountAdminClient({ workerUrl: state.worker.url, adminSecret: state.worker.accountAdminSecret });
}

async function performAccountAction({ action, args, client, confirm }) {
  if (action === "list") return client.list();
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
  throw new Error("Unknown account action. Use list, add, role, enable, disable, rotate-password, or remove.");
}

function printAccountResult(action, result) {
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
    console.log("Save this password now; it is not stored locally or shown again.");
  }
  if (result.removed) console.log("Account removed.");
}
