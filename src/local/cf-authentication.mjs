import { runCf as defaultRunCf } from "./shell.mjs";

const CF_DEPLOYMENT_SCOPES = Object.freeze(["account-settings.read","user-details.read","workers-scripts.read","workers-scripts.write","workers-scripts.bind","workers-routes.read","workers-routes.write","workers-observability.read","workers-observability.write","offline"]);

export function cfAuthenticationResult(result = {}) {
  if (result.code !== 0 || result.stdout_truncated_bytes || result.stderr_truncated_bytes
      || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 128 * 1024) {
    return { authenticated: false, accounts: [] };
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { return { authenticated: false, accounts: [] }; }
  if (!value || Array.isArray(value) || value.authenticated !== true
      || (value.tokenValid !== undefined && value.tokenValid !== true)) {
    return { authenticated: false, accounts: [] };
  }
  const accounts = Array.isArray(value.accounts) ? value.accounts
    .filter(account => account && typeof account.id === "string" && /^[a-f0-9]{32}$/i.test(account.id))
    .map(account => ({ id: account.id.toLowerCase() })) : [];
  return { authenticated: true, accounts };
}

export async function ensureCfAuthenticated({
  runCf = defaultRunCf, shared = {}, interactive = false, logger = console,
} = {}) {
  const probe = () => runCf(["auth", "whoami"], { ...shared, capture: true, allowFailure: true, maxOutputBytes: 128 * 1024 });
  let auth = cfAuthenticationResult(await probe());
  if (auth.authenticated) return { ...auth, login_performed: false };
  if (!interactive) throw cfAuthenticationRequiredError();
  logger.info?.("Cloudflare cf is not logged in; opening Cloudflare login");
  const login = ["auth", "login"];
  await runCf([...login, "--scopes", ...CF_DEPLOYMENT_SCOPES], shared);
  auth = cfAuthenticationResult(await probe());
  if (!auth.authenticated) throw cfAuthenticationRequiredError();
  return { ...auth, login_performed: true };
}

export function cfDeploymentAccount(auth, environment = process.env) {
  const configured = environment.CLOUDFLARE_ACCOUNT_ID;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !/^[a-f0-9]{32}$/i.test(configured)
        || (auth.accounts.length && !auth.accounts.some(account => account.id === configured.toLowerCase()))) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID does not identify an accessible Cloudflare account");
    }
    return configured.toLowerCase();
  }
  if (auth.accounts.length === 1) return auth.accounts[0].id;
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID to the existing Worker's account before deploying with cf");
}

export function cfAuthenticationRequiredError() {
  const error = new Error(
    "Cloudflare cf is not authenticated; unattended activation will not start interactive login. Complete cf auth login in an ordinary owner terminal before retrying.",
  );
  error.code = "worker_authentication_required";
  error.sideEffectsStarted = false;
  return error;
}
