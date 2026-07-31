export function enqueueSecurityAudit(securityAudit, operation, outcome, failureReporter) {
  if (!securityAudit?.record || operation.context.origin !== "relay") return;
  let persistence;
  try {
    persistence = securityAudit.record({
      ...outcome,
      tool: operation.tool,
      riskCategory: operation.context.operationAuthorization?.category || "ordinary operation",
      targetHash: operation.context.operationAuthorization?.targetHash || "",
      principal: operation.context.authority?.principal || {},
      inputBytes: safeByteLength(operation.args),
    });
  } catch (error) {
    operation.context.auditWarning = "security_audit_unavailable";
    failureReporter.report("security.audit.enqueue.failed", { error_class: auditErrorClass(error) }, "Security audit event could not be queued");
    return;
  }
  Promise.resolve(persistence).then((recorded) => {
    if (recorded) return;
    operation.context.auditWarning = "security_audit_unavailable";
    failureReporter.report("security.audit.persist.failed", { tool: operation.tool }, "Security audit event could not be persisted");
  }).catch((error) => {
    operation.context.auditWarning = "security_audit_unavailable";
    failureReporter.report("security.audit.persist.failed", {
      error_class: auditErrorClass(error), tool: operation.tool,
    }, "Security audit event could not be persisted");
  });
}

function safeByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}
function auditErrorClass(error) {
  return String(error?.code || error?.name || "audit_error").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
