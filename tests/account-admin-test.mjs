import { AccountAccessGate, accountRoleToolNames, normalizeAccountRole } from "../src/local/account-access.mjs";
import { accountRoleToolNames as workerAccountRoleToolNames } from "../src/worker/access.ts";
import { validateToolArguments } from "../src/local/tool-executor.mjs";
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
for (const [role, localTools] of [["reviewer", reviewerTools], ["editor", editorTools], ["operator", operatorTools], ["owner", ownerTools]]) {
  const workerTools = workerAccountRoleToolNames(role, ownerTools);
  assert(JSON.stringify([...workerTools].sort()) === JSON.stringify([...localTools].sort()),
    `local and Worker account tool discovery diverged for ${role}`);
}
assert(reviewerTools.has("read_file") && !reviewerTools.has("write_file") && !reviewerTools.has("run_process"), "reviewer tool boundary is incorrect");
assert(editorTools.has("write_file") && !editorTools.has("run_process"), "editor tool boundary is incorrect");
assert(operatorTools.has("run_process") && !operatorTools.has("exec_command"), "operator tool boundary is incorrect");
assert(!reviewerTools.has("diagnose_runtime") && !editorTools.has("diagnose_runtime") && !operatorTools.has("diagnose_runtime")
  && !reviewerTools.has("list_local_resources") && !editorTools.has("list_local_resources") && !operatorTools.has("list_local_resources")
  && !editorTools.has("stage_job") && !operatorTools.has("stage_job") && !operatorTools.has("start_job"),
"non-owner tool discovery exposed owner-only diagnostics, resource inventory, or persistent execution tools");
assert(ownerTools.has("exec_command") && ownerTools.has("browser_action") && ownerTools.has("diagnose_runtime") && ownerTools.has("list_local_resources")
  && ownerTools.has("stage_job") && ownerTools.has("start_job"),
"owner tool boundary is incomplete");
gate.assert("reviewer", "read_file");
expectThrow(() => gate.assert("reviewer", "write_file"), "disabled by the active policy");
expectThrow(() => gate.assert("reviewer", "diagnose_runtime"), "reserved for the owner account");
expectThrow(() => gate.assert("reviewer", "list_local_resources"), "reserved for the owner account");
expectThrow(() => gate.assert("editor", "stage_job"), "reserved for the owner account");
expectThrow(() => gate.assert("operator", "start_job"), "reserved for the owner account");
const idempotentStart = validateToolArguments("start_job", {
  idempotency_key: "retry:managed-job-001",
  steps: [{ argv: ["echo", "ok"] }],
});
assert(idempotentStart.known && idempotentStart.valid, "public start_job schema rejected the manager's durable idempotency key");
const invalidIdempotency = validateToolArguments("start_job", {
  idempotency_key: "contains space",
  steps: [{ argv: ["echo", "ok"] }],
});
assert(invalidIdempotency.known && !invalidIdempotency.valid, "public start_job schema accepted a non-canonical idempotency key");

const generated = generateAccountPassword();
assert(/^account_password_[A-Za-z0-9_-]{43}$/.test(generated), "generated account password has the wrong shape or entropy");
const origin = "https://bridge.example.test";
const now = 1_800_000_000_000;
const sessionIdentity = createDeviceSessionIdentity(createDeviceIdentity(), origin, "machine-bridge-mcp", "3.0.0", now);
const historicalNow = 1_700_000_000_000;
const historicalSessionIdentity = createDeviceSessionIdentity(createDeviceIdentity(), origin, "machine-bridge-mcp", "3.0.0", historicalNow);

const requests = [];
const accounts = [
  { account_id: `acct_${"a".repeat(32)}`, name: "owner", role: "owner", active: true },
  { account_id: `acct_${"b".repeat(32)}`, name: "reviewer", role: "reviewer", active: true },
];
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  assert(options.headers.authorization === undefined, "account administration used a bearer token");
  assert(options.redirect === "error", "account administration allowed automatic HTTP redirects");
  for (const name of ["X-Bridge-Admin-Scheme", "X-Bridge-Admin-Time", "X-Bridge-Admin-Nonce", "X-Bridge-Admin-Body-SHA256", "X-Bridge-Admin-Key", "X-Bridge-Admin-Signature", "X-Bridge-Device-Certificate"]) {
    assert(typeof options.headers[name] === "string" && options.headers[name], `account admin device-signature header was omitted: ${name}`);
  }
  if (url.endsWith("/admin/clients") && options.method === "GET") {
    return jsonResponse({ clients: [{ client_id: `mcp_client_${"c".repeat(43)}`, client_name: "Test Client" }] });
  }
  if (options.method === "GET") return jsonResponse({ accounts, maximum: 64 });
  if (url.endsWith("/rotate-password")) return jsonResponse({ account: accounts[1] });
  if (url.endsWith("/admin/clients") && options.method === "DELETE") {
    return jsonResponse({ removed: true, client_id: `mcp_client_${"c".repeat(43)}` });
  }
  if (url.endsWith("/admin/accounts") && options.method === "DELETE") return new Response(null, { status: 204 });
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
const historicalHeaders = accountAdminRequestHeaders({
  sessionIdentity: historicalSessionIdentity,
  origin,
  method: "GET",
  pathname: "/admin/accounts",
  now: historicalNow,
  nonce: "h".repeat(32),
});
assert(historicalHeaders["X-Bridge-Admin-Time"] === "1700000000"
  && /^[A-Za-z0-9_-]{86}$/.test(historicalHeaders["X-Bridge-Admin-Signature"])
  && historicalHeaders["X-Bridge-Device-Certificate"],
"synthetic historical account-admin signing switched back to real wall time inside session helpers");

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

const networkFailureClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => { throw new Error("synthetic network failure"); },
});
const retryableReadFailure = await expectReject(() => networkFailureClient.list(), "account administration request failed");
assert(retryableReadFailure.retryable === true, "read-only account administration network failure was not retryable");
const ambiguousMutationFailure = await expectReject(
  () => networkFailureClient.update({ accountId: accounts[0].account_id, displayName: "updated" }),
  "account administration request failed",
);
assert(ambiguousMutationFailure.retryable === false
  && ambiguousMutationFailure.details?.request_delivery === "unknown"
  && ambiguousMutationFailure.details?.effect_settlement === "unknown",
"account mutation network failure invited an unsafe automatic retry or hid delivery ambiguity");

const hostileErrorClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => jsonResponse({ message: `unsafe\u001b[31m\u202E${"x".repeat(4_000)}` }, 400),
});
const hostileError = await expectReject(() => hostileErrorClient.list(), "unsafe");
assert(hostileError.message.length <= 2_000 && !/[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(hostileError.message),
  "remote account-admin error text could inject controls or unbounded content into the local terminal");

const wrongSuccessStatusClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(null, { status: 204 }),
});
const wrongSuccessStatus = await expectReject(() => wrongSuccessStatusClient.list(), "unexpected success status");
assert(wrongSuccessStatus.code === "protocol_error", "account-admin accepted a success status outside the method contract");
const wrongClientDeleteStatus = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(null, { status: 204 }),
});
const clientDeleteStatusError = await expectReject(
  () => wrongClientDeleteStatus.removeClient({ clientId: `mcp_client_${"c".repeat(43)}` }),
  "unexpected success status",
);
assert(clientDeleteStatusError.code === "protocol_error" && clientDeleteStatusError.retryable === false
  && clientDeleteStatusError.details?.request_delivery === "sent"
  && clientDeleteStatusError.details?.effect_settlement === "unknown",
"OAuth client deletion accepted the account-delete 204 contract or lost ambiguous mutation settlement");
const wrongAccountDeleteStatus = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => jsonResponse({ removed: true }),
});
const accountDeleteStatusError = await expectReject(
  () => wrongAccountDeleteStatus.remove({ accountId: accounts[1].account_id }),
  "unexpected success status",
);
assert(accountDeleteStatusError.code === "protocol_error" && accountDeleteStatusError.retryable === false
  && accountDeleteStatusError.details?.request_delivery === "sent"
  && accountDeleteStatusError.details?.effect_settlement === "unknown",
"account deletion accepted the OAuth-client-delete 200 contract or lost ambiguous mutation settlement");

const serverFailureClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => jsonResponse({ error: "internal_server_error" }, 500),
});
const retryableServerReadFailure = await expectReject(() => serverFailureClient.list(), "internal_server_error");
assert(retryableServerReadFailure.code === "unavailable" && retryableServerReadFailure.retryable === true,
  "account-admin read-side Worker failure was misclassified as a caller request error");
const ambiguousServerMutationFailure = await expectReject(
  () => serverFailureClient.update({ accountId: accounts[0].account_id, displayName: "updated" }),
  "internal_server_error",
);
assert(ambiguousServerMutationFailure.code === "unavailable" && ambiguousServerMutationFailure.retryable === false
  && ambiguousServerMutationFailure.details?.request_delivery === "sent"
  && ambiguousServerMutationFailure.details?.effect_settlement === "unknown",
"account-admin mutation Worker failure lost delivered-but-unsettled side-effect semantics");

const invalidJsonClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
});
const invalidJsonResponse = await expectReject(() => invalidJsonClient.list(), "not valid JSON");
assert(invalidJsonResponse.code === "protocol_error", "malformed account-admin response used a non-contract error code");
const invalidJsonMutation = await expectReject(
  () => invalidJsonClient.update({ accountId: accounts[0].account_id, displayName: "updated" }),
  "not valid JSON",
);
assert(invalidJsonMutation.code === "protocol_error" && invalidJsonMutation.retryable === false
  && invalidJsonMutation.details?.request_delivery === "sent"
  && invalidJsonMutation.details?.effect_settlement === "unknown",
"malformed successful mutation response lost delivered-but-unsettled side-effect semantics");

let oversizedCancelled = false;
const oversizedClient = new AccountAdminClient({
  workerUrl: origin,
  sessionIdentity,
  fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600 * 1024)); },
    cancel() { oversizedCancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "application/json" } }),
});
const oversizedResponse = await expectReject(() => oversizedClient.list(), "size limit");
assert(oversizedResponse.code === "protocol_error", "oversized account-admin response used a non-contract error code");
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
    return error;
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
