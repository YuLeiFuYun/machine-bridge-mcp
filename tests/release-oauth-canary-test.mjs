import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_OAUTH_CANARY_CALLBACK,
  runReleaseOAuthCanaryFlow,
} from "../scripts/release-oauth-canary-core.mjs";
import {
  RELEASE_OAUTH_CANARY_SCHEMA_VERSION,
  readReleaseOAuthCanaryEvidence,
  writeReleaseOAuthCanaryEvidence,
} from "../scripts/release-oauth-canary-evidence.mjs";

const ORIGIN = "https://bridge.example.test";
const VERSION = "3.0.0-beta.61";
const CLIENT_ID = `mcp_client_${"c".repeat(43)}`;
const CODE = `mcp_code_${"d".repeat(43)}`;
const ACCESS = `mcp_at_${"a".repeat(43)}`;
const REFRESH = `mcp_rt_${"r".repeat(43)}`;
const NEXT_ACCESS = `mcp_at_${"b".repeat(43)}`;
const NEXT_REFRESH = `mcp_rt_${"s".repeat(43)}`;
const ACCOUNT_ID = `acct_${"q".repeat(32)}`;
const OWNER_ACCOUNT = {
  account_id: `acct_${"o".repeat(32)}`, name: "release-owner", display_name: "Release Owner",
  role: "owner", active: true,
};
const SCOPE = "machine-bridge-mcp offline_access";

testEntrypointRejectsUnrecordedOverrides();
testEntrypointRejectsNodeStartupOptions();
await testSuccessfulFlowAndCleanup();
await testCanaryRequiresExistingOwner();
await testStaleSyntheticStateIsReclaimed();
await testSyntheticNameCollisionFailsClosed();
await testFailureStillCleansTemporaryState();
await testCleanupFailureFailsClosed();
testEvidenceBinding();
console.log("Release OAuth canary test ok");

function testEntrypointRejectsUnrecordedOverrides() {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../scripts/release-oauth-canary.mjs", import.meta.url));
  for (const override of [["--state-dir", tmpdir()], ["--workspace", repositoryRoot]]) {
    const result = spawnSync(process.execPath, [entry, "--allow-live-oauth-canary", ...override], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 1, `release OAuth canary accepted unrecorded ${override[0]} override`);
    assert.match(result.stderr, /release OAuth canary requires exact argv/,
      `release OAuth canary did not reject unrecorded ${override[0]} override before live state access`);
  }
}

function testEntrypointRejectsNodeStartupOptions() {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../scripts/release-oauth-canary.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--no-warnings", entry, "--allow-live-oauth-canary"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 1, "release OAuth canary accepted Node CLI startup options");
  assert.match(result.stderr, /refuses Node CLI startup options/,
    "release OAuth canary did not reject Node CLI startup options before live state access");
}

async function testSuccessfulFlowAndCleanup() {
  const admin = fakeAdmin();
  const requests = [];
  const result = await runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const path = new URL(url).pathname;
      assert.equal(init.redirect, path === "/oauth/authorize" ? "manual" : "error",
        `release canary used the wrong redirect policy for ${path}`);
      if (path === "/oauth/register") return json({ client_id: CLIENT_ID }, 201);
      if (path === "/oauth/authorize") {
        const body = new URLSearchParams(init.body);
        const location = new URL(RELEASE_OAUTH_CANARY_CALLBACK);
        location.searchParams.set("code", CODE);
        location.searchParams.set("state", body.get("state"));
        location.searchParams.set("iss", ORIGIN);
        return new Response(null, { status: 303, headers: { location: String(location) } });
      }
      if (path === "/oauth/token") {
        const body = new URLSearchParams(init.body);
        if (body.get("grant_type") === "authorization_code") {
          assert.equal(body.get("code_verifier")?.length, 43);
          return json({ access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer", scope: SCOPE });
        }
        assert.equal(body.get("refresh_token"), REFRESH);
        return json({ access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, token_type: "Bearer", scope: SCOPE });
      }
      if (path === "/mcp") {
        assert.match(String(init.headers.authorization), /^Bearer mcp_at_/);
        return json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { structuredContent: { version: VERSION } } });
      }
      throw new Error(`unexpected canary request path: ${path}`);
    },
  });
  assert.deepEqual(result, {
    workerVersion: VERSION,
    authorizationCodeExchange: true,
    authenticatedMcp: true,
    refreshRotation: true,
    refreshedMcp: true,
    cleanupCompleted: true,
  });
  assert.deepEqual(admin.removedClients, [CLIENT_ID]);
  assert.deepEqual(admin.removedAccounts, [ACCOUNT_ID]);
  assert.equal(requests.filter(({ url }) => url.endsWith("/oauth/token")).length, 2);
  assert.equal(requests.filter(({ url }) => url.endsWith("/mcp")).length, 2);
}

async function testCanaryRequiresExistingOwner() {
  const admin = fakeAdmin({ accounts: [] });
  await assert.rejects(() => runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: successfulFetch,
  }), /requires an existing active owner/);
  assert.equal(admin.createdAccounts, 0, "ownerless canary attempted to create non-removable synthetic state");
}

async function testStaleSyntheticStateIsReclaimed() {
  const staleClientId = `mcp_client_${"x".repeat(43)}`;
  const spoofedClientId = `mcp_client_${"z".repeat(43)}`;
  const staleAccountId = `acct_${"y".repeat(32)}`;
  const admin = fakeAdmin({
    clients: [
      { client_id: staleClientId, client_name: "Machine Bridge release OAuth canary", trusted_account_id: staleAccountId },
      { client_id: spoofedClientId, client_name: "Machine Bridge release OAuth canary" },
    ],
    accounts: [OWNER_ACCOUNT, {
      account_id: staleAccountId, name: "release-canary-deadbeefdeadbeef", role: "reviewer", active: true,
      display_name: "Machine Bridge Release OAuth Canary",
    }],
  });
  await runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: successfulFetch,
  });
  assert.deepEqual(admin.removedClients, [staleClientId, CLIENT_ID], "stale synthetic client was not reclaimed before the new canary");
  assert(!admin.removedClients.includes(spoofedClientId), "public DCR client-name spoofing caused destructive stale-canary cleanup");
  assert.deepEqual(admin.removedAccounts, [staleAccountId, ACCOUNT_ID], "stale synthetic account was not reclaimed before the new canary");
}

async function testSyntheticNameCollisionFailsClosed() {
  const protectedAccountId = `acct_${"p".repeat(32)}`;
  const admin = fakeAdmin({
    accounts: [OWNER_ACCOUNT, {
      account_id: protectedAccountId, name: "release-canary-cafebabecafebabe", role: "reviewer", active: true,
      display_name: "User-created reviewer",
    }],
  });
  await assert.rejects(() => runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: successfulFetch,
  }), /without the synthetic reviewer marker/);
  assert(!admin.removedAccounts.includes(protectedAccountId), "synthetic-name collision deleted a non-canary account");
}

async function testFailureStillCleansTemporaryState() {
  const admin = fakeAdmin();
  await assert.rejects(() => runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/register") return json({ client_id: CLIENT_ID }, 201);
      if (path === "/oauth/authorize") {
        const body = new URLSearchParams(init.body);
        return new Response(null, {
          status: 303,
          headers: { location: `${RELEASE_OAUTH_CANARY_CALLBACK}?code=${CODE}&state=${body.get("state")}&iss=${encodeURIComponent(ORIGIN)}` },
        });
      }
      if (path === "/oauth/token") return json({ error: "server_error" }, 500);
      throw new Error(`unexpected request after failed token exchange: ${path}`);
    },
  }), /authorization-code token exchange failed with HTTP 500/);
  assert.deepEqual(admin.removedClients, [CLIENT_ID], "failed canary left its temporary OAuth client behind");
  assert.deepEqual(admin.removedAccounts, [ACCOUNT_ID], "failed canary left its temporary account behind");
}

async function testCleanupFailureFailsClosed() {
  const admin = fakeAdmin({ failClientCleanup: true });
  await assert.rejects(() => runReleaseOAuthCanaryFlow({
    admin,
    workerUrl: ORIGIN,
    packageName: "machine-bridge-mcp",
    packageVersion: VERSION,
    randomBytesImpl: deterministicRandomBytes,
    fetchImpl: successfulFetch,
  }), /temporary state cleanup was incomplete/);
  assert.deepEqual(admin.removedAccounts, [ACCOUNT_ID], "account cleanup was skipped after client cleanup failed");
}

function testEvidenceBinding() {
  const root = mkdtempSync(join(tmpdir(), "mbm-oauth-canary-test-"));
  try {
    mkdirSync(join(root, ".release-candidate"), { recursive: true, mode: 0o700 });
    writeReleaseOAuthCanaryEvidence(root, {
      schema_version: RELEASE_OAUTH_CANARY_SCHEMA_VERSION,
      result: "passed",
      package_name: "machine-bridge-mcp",
      package_version: VERSION,
      shasum: "a".repeat(40),
      integrity: "sha512-YQ==",
      promotion_content_sha256: "b".repeat(64),
      worker_version: VERSION,
      authorization_code_exchange: true,
      authenticated_mcp: true,
      refresh_rotation: true,
      refreshed_mcp: true,
      cleanup_completed: true,
      completed_at: "2026-08-11T00:00:00.000Z",
    });
    const evidence = readReleaseOAuthCanaryEvidence(root, {
      package_version: VERSION,
      shasum: "a".repeat(40),
      integrity: "sha512-YQ==",
    });
    assert.equal(evidence.worker_version, VERSION);
    assert.throws(() => readReleaseOAuthCanaryEvidence(root, { shasum: "c".repeat(40) }), /does not match the candidate: shasum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeAdmin(options = {}) {
  const defaultAccounts = [OWNER_ACCOUNT];
  return {
    removedClients: [],
    removedAccounts: [],
    createdAccounts: 0,
    async listClients() { return { clients: structuredClone(options.clients || []) }; },
    async list() { return { accounts: structuredClone(options.accounts ?? defaultAccounts) }; },
    async create(input) {
      this.createdAccounts += 1;
      assert.equal(input.role, "reviewer");
      assert.equal(input.displayName, "Machine Bridge Release OAuth Canary");
      assert.match(input.name, /^release-canary-[a-f0-9]{16}$/);
      assert.match(input.password, /^account_password_[A-Za-z0-9_-]{43}$/);
      return { account: { account_id: ACCOUNT_ID } };
    },
    async removeClient({ clientId }) {
      if (options.failClientCleanup) throw new Error("synthetic cleanup failure");
      this.removedClients.push(clientId);
      return { removed: true };
    },
    async remove({ accountId }) {
      this.removedAccounts.push(accountId);
      return { removed: true };
    },
  };
}

async function successfulFetch(url, init) {
  const path = new URL(url).pathname;
  if (path === "/oauth/register") return json({ client_id: CLIENT_ID }, 201);
  if (path === "/oauth/authorize") {
    const body = new URLSearchParams(init.body);
    return new Response(null, {
      status: 303,
      headers: { location: `${RELEASE_OAUTH_CANARY_CALLBACK}?code=${CODE}&state=${body.get("state")}&iss=${encodeURIComponent(ORIGIN)}` },
    });
  }
  if (path === "/oauth/token") {
    const body = new URLSearchParams(init.body);
    return body.get("grant_type") === "authorization_code"
      ? json({ access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer", scope: SCOPE })
      : json({ access_token: NEXT_ACCESS, refresh_token: NEXT_REFRESH, token_type: "Bearer", scope: SCOPE });
  }
  if (path === "/mcp") return json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { structuredContent: { version: VERSION } } });
  throw new Error(`unexpected canary request path: ${path}`);
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 0x41);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
