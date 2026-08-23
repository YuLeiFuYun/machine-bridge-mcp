import { toolCallAdmission, type ToolCallCapacityConfig } from "../shared/tool-call-capacity.mjs";
import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { PendingCallRegistrationError, type PendingCallRecord, type RegisterPendingCall } from "./pending-call-contract.ts";
import { boundedPendingDelayMs } from "./pending-call-deadlines.ts";
import { MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, pendingReadJobCallsForAccount } from "./pending-call-capacity.ts";

type PendingRegistrationState = Readonly<{
  records: Iterable<PendingCallRecord>;
  active: number;
  byTool: Record<string, number>;
  capacity: ToolCallCapacityConfig;
  idExists: boolean;
  requestKeyExists: boolean;
}>;

export function assertPendingCallRegistration(input: RegisterPendingCall, state: PendingRegistrationState): void {
  boundedPendingDelayMs(input.timeoutMs, pendingCallTimeoutMaximumMs(input.tool));
  const decision = toolCallAdmission({ active: state.active, byTool: state.byTool }, state.capacity, input.tool);
  if (!decision.allowed) {
    const message = decision.reason === "ordinary_capacity"
      ? `ordinary daemon-call capacity reached (${decision.ordinaryMaximum}); control-plane capacity is reserved for diagnosis and recovery`
      : "too many concurrent daemon tool calls";
    throw new PendingCallRegistrationError("limit_exceeded", message, true);
  }
  if (state.idExists) throw new PendingCallRegistrationError("conflict", "duplicate internal daemon call id");
  if (input.clientRequestKey && state.requestKeyExists) {
    throw new PendingCallRegistrationError("conflict", "duplicate in-flight response-stream request key");
  }
  if (input.tool === "read_job" && input.authority?.accountId
      && pendingReadJobCallsForAccount(state.records, input.authority.accountId) >= MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT) {
    throw new PendingCallRegistrationError(
      "limit_exceeded",
      `managed-job read capacity reached for this account (${MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT})`,
      true,
    );
  }
}

export function pendingCallTimeoutMaximumMs(tool: string): number {
  return tool === "read_job"
    ? relayContract.maximumRelayToolTimeoutMs
    : relayContract.maximumOrdinaryRelayToolTimeoutMs;
}
