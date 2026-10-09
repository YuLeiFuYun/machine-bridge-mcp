import { BridgeError } from "./errors.mjs";
import { operationMayHaveSideEffects } from "./operation-risk.mjs";
import { persistSecurityAuditDispatchIntent } from "./security-audit-dispatch.mjs";

const AUDIT_DISPATCH_TIMEOUT_MS = 5_000;

export function securityAuditPreDispatchMiddleware(securityAudit) {
  return async (operation, next) => {
    if (operation.context.origin !== "relay" || !operationMayHaveSideEffects(operation.tool)) {
      return next(operation);
    }
    let recorded = false;
    try { recorded = await boundedAuditIntent(securityAudit, operation); }
    catch { recorded = false; }
    if (!recorded) {
      throw new BridgeError("unavailable", "security audit is unavailable; remote operation was not dispatched", {
        retryable: true,
        details: { reason: "security_audit_unavailable" },
      });
    }
    return next(operation);
  };
}

async function boundedAuditIntent(securityAudit, operation) {
  let timer;
  try {
    return await Promise.race([
      persistSecurityAuditDispatchIntent(securityAudit, operation),
      new Promise((resolve) => { timer = setTimeout(() => {
          securityAudit.markUnavailable?.(Object.assign(new Error("security audit pre-dispatch timed out"), { code: "audit_dispatch_timeout" }));
          resolve(false);
        }, AUDIT_DISPATCH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}
