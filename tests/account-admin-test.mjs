import { AccountAccessGate, accountRoleToolNames, normalizeAccountRole } from "../src/local/account-access.mjs";
import { AccountAdminClient, accountRoleNames, generateAccountPassword } from "../src/local/account-admin.mjs";

const roles = accountRoleNames();
assert(JSON.stringify(roles) === JSON.stringify(["reviewer", "editor", "operator", "owner"]), "account roles differ from the shared contract");
assert(normalizeAccountRole(" OWNER ") === "owner", "account role normalization failed");
expectThrow(() => normalizeAccountRole("administrator"), "unknown account role");
for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
  expectThrow(() => normalizeAccountRole(inherited), "unknown account role");
}

const gate = new AccountAccessGate();
const reviewerTools = new Set(accountRoleToolNames("reviewer"));
const editorTools = new Set(accountRoleToolNames("editor"));
const operatorTools = new Set(accountRoleToolNames("operator"));
const ownerTools = new Set(accountRoleToolNames("owner"));
assert(reviewerTools.has("read_file") && !reviewerTools.has("write_file") && !reviewerTools.has("run_process"), "reviewer tool boundary is incorrect");
assert(editorTools.has("write_file") && !editorTools.has("run_process"), "editor tool boundary is incorrect");
assert(operatorTools.has("run_process") && !operatorTools.has("exec_command"), "operator tool boundary is incorrect");
assert(ownerTools.has("exec_command") && ownerTools.has("browser_action"), "owner tool boundary is incomplete");
gate.assert("reviewer", "read_file");
expectThrow(() => gate.assert("reviewer", "write_file"), "disabled by the active policy");

const generated = generateAccountPassword();
assert(/^account_password_[A-Za-z0-9_-]{43}$/.test(generated), "generated account password has the wrong shape or entropy");

const requests = [];
const accounts = [
  { account_id: `acct_${"a".repeat(32)}`, name: "owner", role: "owner", active: true },
  { account_id: `acct_${"b".repeat(32)}`, name: "reviewer", role: "reviewer", active: true },
];
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  assert(options.headers.authorization === "Bearer account_admin_test_secret_123456789", "account admin bearer secret was omitted");
  if (options.method === "GET") return jsonResponse({ accounts, maximum: 64 });
  if (url.endsWith("/rotate-password")) return jsonResponse({ account: accounts[1] });
  if (options.method === "DELETE") return new Response(null, { status: 204 });
  const body = JSON.parse(options.body);
  return jsonResponse({ account: { ...accounts[1], ...body } }, options.method === "POST" ? 201 : 200);
};
const client = new AccountAdminClient({
  workerUrl: "https://bridge.example.test",
  adminSecret: "account_admin_test_secret_123456789",
  fetchImpl,
});
assert((await client.list()).accounts.length === 2, "account list response was not returned");
assert((await client.find("reviewer")).account_id === accounts[1].account_id, "account lookup by name failed");
assert((await client.find(accounts[0].account_id)).name === "owner", "account lookup by id failed");
await client.create({ name: "build-bot", role: "operator", password: generated });
await client.update({ accountId: accounts[1].account_id, role: "editor", active: false });
await client.rotatePassword({ accountId: accounts[1].account_id, password: generated });
assert((await client.remove({ accountId: accounts[1].account_id })).removed === true, "account removal response was not normalized");
assert(requests.some((request) => request.url.endsWith("/admin/accounts/rotate-password")), "password rotation used the wrong endpoint");
expectThrow(() => new AccountAdminClient({ workerUrl: "http://bridge.example.test", adminSecret: "account_admin_test_secret_123456789" }), "HTTPS origin");
expectThrow(() => new AccountAdminClient({ workerUrl: "https://bridge.example.test/path", adminSecret: "account_admin_test_secret_123456789" }), "HTTPS origin");
expectThrow(() => client.create({ name: "INVALID NAME", role: "reviewer", password: generated }), "account name");
expectThrow(() => client.create({ name: "a", role: "reviewer", password: generated }), "3-64");

console.log("account authorization/admin client test ok");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function expectThrow(fn, message) {
  try {
    fn();
  } catch (error) {
    assert(String(error?.message || error).includes(message), `unexpected error: ${error?.message || error}`);
    return;
  }
  throw new Error(`expected error containing: ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
