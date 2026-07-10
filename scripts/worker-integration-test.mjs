import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const port = await openPort();
const base = `http://127.0.0.1:${port}`;
const persistDir = await mkdtemp(path.join(os.tmpdir(), "mbm-worker-test-"));
const wrangler = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const args = [
  "dev",
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--persist-to", persistDir,
  "--show-interactive-dev-session=false",
  "--var", "MCP_OAUTH_PASSWORD:integration-password",
  "--var", "DAEMON_SHARED_SECRET:integration-daemon-secret",
  "--var", "OAUTH_TOKEN_VERSION:integration-token-version",
  "--var", "MBM_ALLOWED_ORIGINS:http://localhost:3001",
];

let logs = "";
const child = spawn(wrangler, args, {
  cwd: packageRoot,
  env: { ...process.env, NO_COLOR: "1", CI: "1" },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
child.stdout.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.stderr.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.once("error", (error) => { logs = appendBounded(logs, error.stack || error.message); });

try {
  const health = await waitForWorker(base, child, closed);
  assert(health.ok === true, "health response was not ok");
  assert(health.server === "machine-bridge-mcp", "health server name mismatch");
  assert(health.version === pkg.version, `health version mismatch: ${health.version} != ${pkg.version}`);
  assert(!("daemon" in health), "public health response leaked daemon state");
  const wrongHealthMethod = await fetch(`${base}/healthz`, { method: "POST" });
  assert(wrongHealthMethod.status === 405, "health endpoint accepted an unsupported method");
  assert(wrongHealthMethod.headers.get("allow") === "GET", "method rejection omitted the Allow header");

  const crossOrigin = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"] }),
  });
  assert(crossOrigin.status === 403, "an unconfigured loopback browser origin was accepted");
  const preflight = await fetch(`${base}/oauth/register`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3001",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(preflight.status === 204, `configured-origin preflight failed: ${preflight.status}`);
  assert(preflight.headers.get("access-control-allow-origin") === "http://localhost:3001", "preflight omitted exact allowed origin");
  const corsHealth = await fetch(`${base}/healthz`, { headers: { origin: "http://localhost:3001" } });
  assert(corsHealth.status === 200, "configured browser origin could not access health endpoint");
  assert(corsHealth.headers.get("access-control-allow-origin") === "http://localhost:3001", "actual response omitted CORS origin");

  const invalidRegistration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://example.com/callback"] }),
  });
  assert(invalidRegistration.status === 400, "non-loopback HTTP redirect URI was accepted");

  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetchJson(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Integration <Client>", redirect_uris: [redirectUri] }),
  });
  assert(registration.response.status === 200, `client registration failed: ${registration.response.status}`);
  assert(typeof registration.body.client_id === "string", "registration did not return client_id");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: registration.body.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "machine-bridge-mcp",
    resource: `${base}/mcp`,
    state: "integration-state",
  };

  const unknownPage = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...authorization, client_id: "unknown" })}`);
  const unknownHtml = await unknownPage.text();
  assert(unknownPage.status === 400, "unknown OAuth client did not fail on GET authorization");
  assert(!unknownHtml.includes('name="login_token"'), "invalid authorization request displayed a password form");

  const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorization)}`);
  const pageHtml = await page.text();
  assert(page.status === 200, `authorization page failed: ${page.status}`);
  assert(pageHtml.includes("Integration &lt;Client&gt;"), "authorization page omitted or failed to escape client name");
  assert(pageHtml.includes(redirectUri), "authorization page omitted redirect URI");
  assert(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), "authorization page lacks CSP frame protection");
  assert(page.headers.get("cache-control") === "no-store", "authorization page is cacheable");

  const wrongPassword = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-wrong" },
    body: new URLSearchParams({ ...authorization, login_token: "wrong-password" }),
    redirect: "manual",
  });
  const wrongHtml = await wrongPassword.text();
  assert(wrongPassword.status === 401, `wrong password returned ${wrongPassword.status}`);
  assert(!wrongHtml.includes("wrong-password"), "authorization response reflected the submitted password");
  assert(wrongHtml.includes("Integration &lt;Client&gt;"), "retry page omitted validated client context");

  const approved = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "mbm-integration-valid" },
    body: new URLSearchParams({ ...authorization, login_token: "integration-password" }),
    redirect: "manual",
  });
  assert(approved.status === 302, `valid authorization returned ${approved.status}`);
  const location = approved.headers.get("location");
  assert(location, "authorization redirect omitted Location");
  const redirect = new URL(location);
  const code = redirect.searchParams.get("code");
  assert(code, "authorization redirect omitted code");
  assert(redirect.searchParams.get("state") === "integration-state", "authorization state was not preserved");

  const wrongVerifier = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: "A".repeat(43),
      resource: `${base}/mcp`,
    }),
  });
  assert(wrongVerifier.status === 400, "invalid PKCE verifier was accepted");

  const token = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(token.response.status === 200, `token exchange failed: ${token.response.status}`);
  assert(typeof token.body.access_token === "string", "token exchange omitted access_token");

  const replay = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registration.body.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  });
  assert(replay.status === 400, "authorization code replay was accepted");

  const invalidUtf8 = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0xff, 0xfe]),
  });
  assert(invalidUtf8.status === 400, "invalid UTF-8 request body was accepted");

  const unauthenticated = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert(unauthenticated.status === 401, "MCP endpoint accepted a request without a bearer token");

  const initialized = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.body.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert(initialized.response.status === 200, `authenticated initialize failed: ${initialized.response.status}`);
  assert(initialized.body.result?.serverInfo?.version === pkg.version, "initialize returned the wrong Worker version");

  console.log("worker OAuth/MCP integration test ok");
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n--- wrangler output ---\n${logs}\n`);
  process.exitCode = 1;
} finally {
  terminate(child, "SIGTERM");
  await Promise.race([closed, sleep(3000)]);
  terminate(child, "SIGKILL");
  await rm(persistDir, { recursive: true, force: true }).catch(() => {});
}

async function waitForWorker(origin, processHandle, closedPromise) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (processHandle.exitCode !== null) {
      const result = await closedPromise;
      throw new Error(`wrangler exited before readiness: ${JSON.stringify(result)}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("wrangler dev did not become ready");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { response, body };
}

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portValue = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(portValue));
    });
  });
}

function terminate(processHandle, signal) {
  if (!processHandle?.pid || processHandle.exitCode !== null) return;
  try {
    if (process.platform === "win32") processHandle.kill(signal);
    else process.kill(-processHandle.pid, signal);
  } catch {
    try { processHandle.kill(signal); } catch {}
  }
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= 100_000 ? next : next.slice(-100_000);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
