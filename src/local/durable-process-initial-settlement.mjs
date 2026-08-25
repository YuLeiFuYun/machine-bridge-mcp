import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { waitForManagedJobRead } from "./managed-job-read-wait.mjs";
import { ACTIVE_JOB_STATES } from "./managed-job-terminal.mjs";

export async function settleDurableProcessAcceptance(manager, accepted, context = {}) {
  if ((context?.origin !== "relay" && context?.authority?.origin !== "relay") || !accepted?.job_id) return accepted;
  const hostedContext = context?.authority?.origin === "relay"
    ? context : { ...context, authority: { ...(context?.authority || {}), origin: "relay" } };
  try {
    const settled = await waitForManagedJobRead({
      args: { job_id: accepted.job_id, wait_ms: relayContract.durableProcessInitialSettlementWaitMs },
      context: hostedContext,
      readCurrent: () => manager.readHosted({ job_id: accepted.job_id }, hostedContext),
      readProgress: () => manager.readProgress({ job_id: accepted.job_id }, hostedContext),
    });
    const terminal = !ACTIVE_JOB_STATES.has(String(settled?.status || "")) && settled?.status !== "staged";
    return {
      ...accepted,
      ...settled,
      recovery: accepted.recovery,
      cleanup: accepted.cleanup,
      execution_mode: accepted.execution_mode,
      source_tool: accepted.source_tool,
      execution_timeout_seconds: accepted.execution_timeout_seconds,
      retry_safety: accepted.retry_safety,
      progress: {
        status: settled.status,
        current_phase: settled.current_phase ?? null,
        current_step: settled.current_step ?? null,
      },
      initial_settlement_terminal: terminal,
      follow_up_read_required: !terminal,
    };
  } catch {
    return {
      ...accepted,
      initial_settlement_terminal: false,
      initial_settlement_unavailable: true,
      follow_up_read_required: true,
    };
  }
}
