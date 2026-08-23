import { McpSubscriptionCapacity } from "./mcp-subscription-capacity.ts";
import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "./mcp-subscription-contract.ts";
import { openSubscriptionResponse } from "./mcp-subscription-stream.ts";
import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../shared/authority-revocation.mjs";

type OpenSubscriptionInput = Readonly<{
  authority: Readonly<{
    accountId: string;
    accountVersion: number;
    clientId: string;
    familyId: string;
  }>;
  requestKey?: string;
  requestSignal: AbortSignal;
  acknowledged: Record<string, unknown>;
  initialMessages: readonly Record<string, unknown>[];
}>;

type ActiveSubscription = Readonly<{
  owner_kind: "account";
  owner_account_id: string;
  owner_account_version: number;
  owner_client_id: string;
  owner_family_id: string;
  cancel: () => void;
}>;

export class McpSubscriptionRegistry {
  private readonly capacity = new McpSubscriptionCapacity();
  private readonly cancelByRequestKey = new Map<string, () => void>();
  private readonly active = new Set<ActiveSubscription>();
  private readonly leaseMs: number;

  constructor(options: Readonly<{ leaseMs?: number }> = {}) {
    this.leaseMs = Number.isSafeInteger(options.leaseMs) && Number(options.leaseMs) > 0
      ? Number(options.leaseMs) : MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS;
  }

  snapshot(accountId: string) {
    return this.capacity.snapshot(accountId);
  }

  cancelRequest(requestKey?: string): boolean {
    if (!requestKey) return false;
    const cancel = this.cancelByRequestKey.get(requestKey);
    if (!cancel) return false;
    cancel();
    return true;
  }

  cancelAuthority(revocation: AuthorityRevocation): number {
    const matching = [...this.active].filter((record) => recordMatchesAuthorityRevocation(record, revocation));
    for (const record of matching) record.cancel();
    return matching.length;
  }

  open(input: OpenSubscriptionInput): Response | null {
    const releaseCapacity = this.capacity.reserve(input.authority.accountId);
    if (!releaseCapacity) return null;

    const controller = new AbortController();
    const cancelWithReason = (reason: string) => { if (!controller.signal.aborted) controller.abort(reason); };
    const cancel = () => cancelWithReason("subscription cancelled");
    const active: ActiveSubscription = {
      owner_kind: "account",
      owner_account_id: input.authority.accountId,
      owner_account_version: input.authority.accountVersion,
      owner_client_id: input.authority.clientId,
      owner_family_id: input.authority.familyId,
      cancel,
    };
    if (input.requestKey) {
      if (this.cancelByRequestKey.has(input.requestKey)) {
        releaseCapacity();
        throw new Error("duplicate subscription request identity");
      }
      this.cancelByRequestKey.set(input.requestKey, cancel);
    }

    const requestAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(input.requestSignal.reason ?? "client request aborted");
      }
    };
    input.requestSignal.addEventListener("abort", requestAbort, { once: true });
    let released = false;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (leaseTimer) clearTimeout(leaseTimer);
      input.requestSignal.removeEventListener("abort", requestAbort);
      if (input.requestKey && this.cancelByRequestKey.get(input.requestKey) === cancel) {
        this.cancelByRequestKey.delete(input.requestKey);
      }
      this.active.delete(active);
      releaseCapacity();
    };

    try {
      if (input.requestSignal.aborted) requestAbort();
      this.active.add(active);
      const response = openSubscriptionResponse(
        input.acknowledged,
        input.initialMessages,
        controller.signal,
        release,
      );
      if (!released) {
        leaseTimer = setTimeout(() => cancelWithReason("subscription lease expired"), this.leaseMs);
      }
      // This records only that the server successfully constructed an open
      // subscription response. It cannot prove that an external client read
      // the acknowledgement or any notification from the response body.
      this.capacity.markOpened(input.authority.accountId);
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }
}
