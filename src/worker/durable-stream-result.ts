import { decorateProjectOverview } from "./authority.ts";
import type { PendingCallOutcome } from "./pending-call-contract.ts";
import type { PendingStreamCallView } from "./mcp-pending-call-store.ts";

export function transformDurableStreamOutcome(
  call: PendingStreamCallView,
  outcome: PendingCallOutcome,
): PendingCallOutcome {
  if (!outcome.ok || call.transform?.kind !== "project_overview") return outcome;
  try {
    return {
      ok: true,
      value: decorateProjectOverview(outcome.value, {
        accountId: call.transform.account_id,
        accountVersion: call.transform.account_version,
        role: call.transform.role,
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error("stream result transformation failed") };
  }
}
