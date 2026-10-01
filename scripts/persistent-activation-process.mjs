import { normalizeActivationRecovery } from "../src/shared/activation-recovery.mjs";
import { EXECUTION_SURFACE, executionSurface } from "../src/local/execution-surface.mjs";
import { runCf as defaultRunCf } from "../src/local/shell.mjs";
import { ensureCfAuthenticated } from "../src/local/cf-authentication.mjs";

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
  surface = "local", stateRoot, packageRoot, npmCli, env = process.env, runCf = defaultRunCf,
} = {}) {
  if (surface !== "local" && surface !== EXECUTION_SURFACE.managedJob) {
    throw new TypeError("persistent activation cf preflight requires a local or managed-job execution surface");
  }
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("persistent activation cf preflight requires stateRoot");
  if (typeof packageRoot !== "string" || !packageRoot) throw new TypeError("persistent activation cf preflight requires packageRoot");
  if (typeof runCf !== "function") throw new TypeError("persistent activation cf preflight requires runCf");
  const auth = await ensureCfAuthenticated({
    runCf, shared: { stateRoot, packageRoot, npmCli, env }, interactive: surface === "local",
  });
  return { authenticated: true, login_performed: auth.login_performed };
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
