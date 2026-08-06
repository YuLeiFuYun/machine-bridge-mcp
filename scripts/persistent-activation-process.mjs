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
  const recovered = value.activation_recovered;
  if (typeof recovered !== "boolean") {
    throw new Error("persistent activation recovery flag is missing or invalid");
  }
  const reason = value.activation_recovery_reason;
  const detail = value.activation_recovery_detail;
  if (!recovered) {
    if (![null, undefined, ""].includes(reason) || ![null, undefined, ""].includes(detail)) {
      throw new Error("persistent activation recovery metadata is inconsistent");
    }
    return Object.freeze({ recovered: false, reason: "", detail: "" });
  }
  if (!/^[a-z0-9_]{1,80}$/.test(String(reason || ""))) {
    throw new Error("persistent activation recovery reason is invalid");
  }
  const text = String(detail || "");
  if (!text || text.length > 600 || /[\r\n\t]/.test(text)) {
    throw new Error("persistent activation recovery detail is invalid");
  }
  return Object.freeze({ recovered: true, reason: String(reason), detail: text });
}
