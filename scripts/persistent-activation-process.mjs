import { normalizeActivationRecovery } from "../src/shared/activation-recovery.mjs";
import { EXECUTION_SURFACE, executionSurface } from "../src/local/execution-surface.mjs";
import { runWrangler as defaultRunWrangler } from "../src/local/shell.mjs";

export function assertPersistentActivationExecutionSurface(environment = process.env) {
  const surface = executionSurface(environment);
  if (!surface || surface === EXECUTION_SURFACE.managedJob) return surface || "local";
  const error = new Error(
    `persistent activation cannot run from ${surface}; use a durable managed job or an ordinary local terminal because activation intentionally replaces the current Machine Bridge daemon`,
  );
  error.code = "unsafe_activation_execution_surface";
  error.sideEffectsStarted = false;
  throw error;
}

export function persistentActivationSpawnOptions({ cwd, env = process.env } = {}) {
  if (typeof cwd !== "string" || !cwd) {
    throw new TypeError("persistent activation subprocess requires cwd");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("persistent activation subprocess requires an environment record");
  }
  // The activation child owns bounded deployment, network, relay, and service
  // stages plus transactional cleanup. An outer timeout could SIGKILL the child
  // while detached helpers remain alive and before compensation releases locks.
  return { cwd, env, encoding: "utf8", windowsHide: true };
}

export async function preflightPersistentActivationWorkerAuth({
  surface = "local",
  stateRoot,
  packageRoot,
  npmCli,
  env = process.env,
  runWrangler = defaultRunWrangler,
} = {}) {
  if (surface !== "local" && surface !== EXECUTION_SURFACE.managedJob) {
    throw new TypeError("persistent activation Wrangler preflight requires a local or managed-job execution surface");
  }
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("persistent activation Wrangler preflight requires stateRoot");
  if (typeof packageRoot !== "string" || !packageRoot) throw new TypeError("persistent activation Wrangler preflight requires packageRoot");
  if (typeof runWrangler !== "function") throw new TypeError("persistent activation Wrangler preflight requires runWrangler");
  const shared = { stateRoot, packageRoot, npmCli, env };
  const whoami = await runWrangler(["whoami"], { ...shared, capture: true, allowFailure: true });
  if (whoami?.code === 0) return { authenticated: true, login_performed: false };
  if (surface === EXECUTION_SURFACE.managedJob) throw workerAuthenticationRequiredError(
    "persistent activation cannot start interactive Wrangler login from a detached managed job; authenticate Cloudflare Wrangler in an ordinary owner terminal before retrying",
  );
  await runWrangler(["login"], shared);
  const verified = await runWrangler(["whoami"], { ...shared, capture: true, allowFailure: true });
  if (verified?.code !== 0) throw workerAuthenticationRequiredError(
    "Cloudflare Wrangler login completed without a verifiable authenticated session; the persistent activation was not started",
  );
  return { authenticated: true, login_performed: true };
}

export function persistentCandidateFailureMessage(output, { cli, stateRoot, previousRuntime = null } = {}) {
  const detail = String(output || "").trim() || "activation subprocess exited unsuccessfully";
  if (!/foreground daemon is active/i.test(detail)) return `persistent candidate activation failed: ${detail}`;
  const quotedCli = JSON.stringify(String(cli || "machine-mcp"));
  const quotedStateRoot = JSON.stringify(String(stateRoot || ""));
  const recovery = previousRuntime?.cli && previousRuntime?.pid
    ? [
      `Verified foreground runtime: ${previousRuntime.version || "unknown"} (pid ${previousRuntime.pid}).`,
      "Stop that foreground daemon, then restore its existing login service with:",
      `node ${JSON.stringify(previousRuntime.cli)} service start`,
      `node ${quotedCli} service status --workspace ${JSON.stringify(previousRuntime.workspace)} --state-dir ${quotedStateRoot}`,
      "Retry candidate activation only after status reports provider active and a verified service daemon for that workspace.",
    ]
    : [
      "The foreground runtime could not be independently resolved to a trusted installed CLI.",
      "Keep it running and inspect its daemon lock and command line before attempting a manual service recovery.",
    ];
  return [
    `persistent candidate activation failed: ${detail}`,
    "No Worker deployment or service replacement was started.",
    ...recovery,
  ].join("\n");
}

export function validateActivationRecoveryPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persistent activation result is invalid");
  }
  try {
    return normalizeActivationRecovery({
      recovered: value.activation_recovered,
      reason: value.activation_recovery_reason,
      detail: value.activation_recovery_detail,
    });
  } catch (error) {
    throw new Error(`persistent ${String(error?.message || "activation recovery metadata is invalid")}`, { cause: error });
  }
}

function workerAuthenticationRequiredError(message) {
  const error = new Error(message);
  error.code = "worker_authentication_required";
  error.sideEffectsStarted = false;
  return error;
}
