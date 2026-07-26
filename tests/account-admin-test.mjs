import { AccountAccessGate, accountRoleToolNames, normalizeAccountRole } from "../src/local/account-access.mjs";
import { AccountAdminClient, accountAdminRequestHeaders, accountRoleNames, generateAccountPassword } from "../src/local/account-admin.mjs";
import { createDeviceIdentity, createDeviceSessionIdentity } from "../src/local/device-identity.mjs";

const roles = accountRoleNames();
assert(JSON.stringify(roles) === JSON.stringify(["reviewer", "editor", "operator", "owner"]), "account roles differ from the shared contract");
assert(normalizeAccountRole(" OWNER ") === "owner", "account role normalization failed");
expectThrow(() => normalizeAccountRole("administrator"), "unknown account role");
for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) expectThrow(() => normalizeAccountRole(inherited), "unknown account role");

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
const origin = "https://bridge.example.test";
const now = 1_800_000_000_000;
const sessionIdentity = createDeviceSessionIdentity(createDeviceIdentity(), origin, "machine-bridge-mcp", "3.0.0", now);

const requests = [];
const accounts = [
  { account_id: `acct_${"a".repeat(32)}`, name: "owner", role: "owner", active: true },
  { account_id: `acct_${"b".repeat(32)}`, name: "reviewer", role: "reviewer", active: true },
];
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  assert(options.headers.authorization === undefined, "account administration used a bearer token");
  for (const name of ["X-Bridge-Admin-Scheme", "X-Bridge-Admin-Time", "X-Bridge-Admin-Nonce", "X-Bridge-Admin-Body-SHA256", "X-Bridge-Admin-Key", "X-Bridge-Admin-Signature", "X-Bridge-Device-Certificate"]) {
    assert(typeof options.headers[name] === "string" && options.headers[name], `account admin device-signature header was omitted: ${name}`);
  }
  if (url.endsWith("/admin/clients") && options.method === "GET") {
    return jsonResponse({ clients: [{ client_id: `mcp_client_${"c".repeat(43)}`, client_name: "Test Client" }] });
  }
  if (options.method === "GET") return jsonResponse({ accounts, maximum: 64 });
  if (url.endsWith("/rotate-password")) return jsonResponse({ account: accounts[1] });
  if (options.method === "DELETE") return new Response(null, { status: 204 });
  const body = JSON.parse(options.body);
  return jsonResponse({ account: { ...accounts[1], ...body } }, options.method === "POST" ? 201 : 200);
};

assertThrows(() => accountAdminRequestHeaders({
  sessionIdentity,
  origin: "https://bridge.example.com/path",
  method: "GET",
  pathname: "/admin/accounts",
  now,
}), "non-origin account admin target was accepted");
const deterministicHeaders = accountAdminRequestHeaders({
  sessionIdentity,
  origin,
  method: "POST",
  pathname: "/admin/accounts",
  body: "{}",
  now,
  nonce: "n".repeat(32),
});
assert(deterministicHeaders["X-Bridge-Admin-Scheme"] === "device-admin-signature-v1", "account admin request used the wrong signature scheme");
assert(deterministicHeaders["X-Bridge-Admin-Time"] === "1800000000", "account admin signature timestamp was not canonical");
assert(deterministicHeaders["X-Bridge-Admin-Key"] === sessionIdentity.keyId, "account admin request lost its ephemeral key binding");
assert(/^[A-Za-z0-9_-]{86}$/.test(deterministicHeaders["X-Bridge-Admin-Signature"]), "account admin P-256 signature has the wrong encoding");
assert(!deterministicHeaders["X-Bridge-Device-Certificate"].includes('"d"'), "account admin header exposed private key material");

const client = new AccountAdminClient({ workerUrl: origin, sessionIdentity, fetchImpl });
assert((await client.list()).accounts.length === 2, "account list response was not returned");
assert((await client.find("reviewer")).account_id === accounts[1].account_id, "account lookup by name failed");
assert((await client.find(accounts[0].account_id)).name === "owner", "account lookup by id failed");
const listedClients = await client.listClients();
assert(listedClients.clients.length === 1, "OAuth client list response was not returned");
assert((await client.removeClient({ clientId: listedClients.clients[0].client_id })).removed === true,
  "OAuth client removal response was not normalized");
expectThrow(() => client.removeClient({ clientId: "invalid" }), "client id is invalid");
await client.create({ name: "build-bot", role: "operator", password: generated });
await client.update({ accountId: accounts[1].account_id, role: "editor", active: false });
await client.rotatePassword({ accountId: accounts[1].account_id, password: generated });
assert((await client.remove({ accountId: accounts[1].account_id })).removed === true, "account removal response was not normalized");
assert(requests.some((request) => request.url.endsWith("/admin/accounts/rotate-password")), "password rotation used the wrong endpoint");
expectThrow(() => new AccountAdminClient({ workerUrl: "http://bridge.example.test", sessionIdentity }), "HTTPS origin");
expectThrow(() => new AccountAdminClient({ workerUrl: "https://bridge.example.test/path", sessionIdentity }), "HTTPS origin");
expectThrow(() => client.create({ name: "INVALID NAME", role: "reviewer", password: generated }), "account name");
expectThrow(() => client.create({ name: "a", role: "reviewer", password: generated }), "3-64");

const invalidJsonClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
});
await expectReject(() => invalidJsonClient.list(), "not valid JSON");

let oversizedCancelled = false;
const oversizedClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600 * 1024)); },
    cancel() { oversizedCancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "application/json" } }),
});
await expectReject(() => oversizedClient.list(), "size limit");
assert(oversizedCancelled, "oversized account-admin response was not cancelled after crossing the bound");

const declaredOversizedClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
    cancel() { oversizedCancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }),
});
await expectReject(() => declaredOversizedClient.list(), "size limit");

const cancellationFailureClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
    cancel() { throw new Error("synthetic cancellation failure"); },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }),
});
await expectReject(() => cancellationFailureClient.list(), "size limit");

console.log("account authorization/device-signed admin client test ok");


async function expectReject(callback, message) {
  try { await callback(); } catch (error) {
    assert(String(error?.message || error).includes(message), `unexpected error: ${error?.message || error}`);
    return;
  }
  throw new Error(`expected rejection containing: ${message}`);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function expectThrow(fn, message) {
  try { fn(); } catch (error) {
    assert(String(error?.message || error).includes(message), `unexpected error: ${error?.message || error}`);
    return;
  }
  throw new Error(`expected error containing: ${message}`);
}
function assertThrows(callback, message) { try { callback(); } catch { return; } throw new Error(message); }
function assert(condition, message) { if (!condition) throw new Error(message); }
