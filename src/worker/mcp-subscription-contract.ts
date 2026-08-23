import relayContract from "../shared/relay-contract.json" with { type: "json" };

// Tool definitions are immutable for one Worker deployment. The initial level-trigger
// gives the client the only freshness edge available within that deployment; this
// bounded lease prevents an unobservable HTTP disconnect from pinning stream capacity.
export const MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS = Math.max(1_000, Number(relayContract.streamHeartbeatMs) * 2);
