export function enqueueSecurityAudit(securityAudit, operation, outcome, failureReporter) {
  if (!securityAudit?.record || operation.context.origin !== "relay") return;
  let persistence;
  try {
    persistence = securityAudit.record(auditInput(operation, outcome));
  } catch (error) {
    failureReporter.report("security.audit.enqueue.failed", { error_class: auditErrorClass(error) }, "Security audit event could not be queued");
    return;
  }
  Promise.resolve(persistence).then((recorded) => {
    if (recorded) return;
    failureReporter.report("security.audit.persist.failed", { tool: operation.tool }, "Security audit event could not be persisted");
  }).catch((error) => {
    failureReporter.report("security.audit.persist.failed", {
      error_class: auditErrorClass(error), tool: operation.tool,
    }, "Security audit event could not be persisted");
  });
}

export async function persistSecurityAuditDispatchIntent(securityAudit, operation) {
  if (!securityAudit?.record || !securityAudit?.flush || operation.context.origin !== "relay") return false;
  if (await securityAudit.flush() !== true) return false;
  return await securityAudit.record(auditInput(operation, {
    outcome: "dispatch_intent",
    sideEffectsStarted: false,
    terminationRequested: false,
  })) === true;
}

function auditInput(operation, outcome) {
  return {
    ...outcome,
    tool: operation.tool,
    riskCategory: operation.context.operationAuthorization?.category || "ordinary operation",
    targetHash: operation.context.operationAuthorization?.targetHash || "",
    principal: operation.context.authority?.principal || {},
    operationId: operation.context.callId,
    inputBytes: safeByteLength(operation.args),
  };
}

function safeByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}
function auditErrorClass(error) {
  return String(error?.code || error?.name || "audit_error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
