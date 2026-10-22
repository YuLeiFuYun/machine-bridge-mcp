import "node:path";
import { randomBytes } from "node:crypto";
import { createDaemonPreflightHeaders } from "../../../src/local/device-identity.mjs";


import { MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS } from "../../../src/worker/mcp-subscription-contract.ts";

import {
  connectDaemon, rejectedDaemonUpgradeStatus, sendDaemonHello, beginDaemonHello,
  completeDaemonProbe, completeDaemonProbeWithRevocations, callToolsList, callTool,
  callServerInfo, waitForWsMessage, waitForWsClose, waitForWsMessageSequence,
  captureWsMessageTypes, currentMcpHeaders, currentMcpRequest, currentMcpCall,
  toolCallRequest, daemonHttpExchange, adminRequest, stableFetch, fetchJson, readSseJsonMessages, readSseJsonRpcResponse, assert, sleep, defaultDaemonPolicy, nextDaemonInstanceId
} from "./common.mjs";

export async function runDaemonAndTaskScenarios(context, authState) {
  const {
    base, pkg, TOOL_SCHEMA_GENERATION, DAEMON_SESSION_IDENTITY, daemonSockets, activeHttpRequests,
    OWNER_PASSWORD,
  } = context;
  let {
    ownerAccessToken, ownerRefreshToken, reviewerToken, reviewerRefreshToken,
    reviewerRegistration, reviewerAccount, editorToken, editorAccount,
    operatorToken, ownerAccount, redirectUri, registration,
    authorization, stableOwnerToolNames,
  } = authState;
  let { logs } = context;

  const oneTimePreflightHeaders = createDaemonPreflightHeaders(
    DAEMON_SESSION_IDENTITY,
    base,
    "machine-bridge-mcp",
    pkg.version,
  );
  const preflightProbeSocket = await connectDaemon(base, oneTimePreflightHeaders);
  daemonSockets.push(preflightProbeSocket);
  const replayStatus = await rejectedDaemonUpgradeStatus(base, oneTimePreflightHeaders);
  assert(replayStatus === 401, `replayed daemon preflight returned unexpected status ${replayStatus}`);

  const firstDaemon = await connectDaemon(base);
  daemonSockets.push(firstDaemon);
  await sendDaemonHello(firstDaemon, ["read_file", "write_file", "exec_command"]);
  const toolsWithDaemon = await callToolsList(base, ownerAccessToken, 20);
  assert(JSON.stringify(toolsWithDaemon.map((tool) => tool.name).sort()) === JSON.stringify(stableOwnerToolNames),
    "daemon connection changed the stable authenticated account tool catalog");
  const firstStatus = await callServerInfo(base, ownerAccessToken, 21);
  assert(firstStatus.daemon?.connected === true, "first daemon did not become active after hello");
  assert(firstStatus.daemon?.tools?.includes("read_file"), "first daemon tools were not advertised");
  assert(!firstStatus.daemon?.tools?.includes("write_file"), "review policy did not filter write_file");
  assert(!firstStatus.daemon?.tools?.includes("exec_command"), "review policy did not filter exec_command");
  assert(firstStatus.daemon?.readiness_verified === true, "first daemon was advertised before end-to-end readiness verification");
  assert(firstStatus.tool_delivery?.remote_managed_job_read_nonterminal_progress_minimum_ms === 30_000,
    "full server_info lost the hosted nonterminal progress coalescing contract");
  const compactFirstStatus = await callServerInfo(base, ownerAccessToken, 210, { detail: "summary" });
  assert(compactFirstStatus.detail === "summary" && compactFirstStatus.version === pkg.version
    && compactFirstStatus.authorization?.account?.role === "owner" && !("account_id" in compactFirstStatus.authorization.account)
    && compactFirstStatus.authorization?.effective_policy?.profile === "review"
    && compactFirstStatus.daemon?.connected === true && compactFirstStatus.daemon?.readiness_verified === true
    && compactFirstStatus.worker?.sockets_live?.ready === 1 && !("observability" in compactFirstStatus.worker)
    && !("remote_managed_job_read_nonterminal_progress_minimum_ms" in compactFirstStatus.tool_delivery)
    && !("oauth" in compactFirstStatus) && !("tools" in compactFirstStatus),
  "remote compact server_info lost authority/readiness state or retained cold-path fields");
  const compactFirstStatusJson = JSON.stringify(compactFirstStatus);
  assert(compactFirstStatusJson.length < JSON.stringify(firstStatus).length * 0.6,
    "remote compact server_info did not materially reduce the payload");
  // Current freshness adds bounded per-account subscription diagnostics; keep explicit headroom without dropping prior summary fields.
  assert(compactFirstStatusJson.length <= 2600,
    `remote compact server_info exceeded its hot-path output budget: ${compactFirstStatusJson.length} chars`);
  const invalidProbeCandidate = await connectDaemon(base);
  daemonSockets.push(invalidProbeCandidate);
  const invalidProbe = await beginDaemonHello(invalidProbeCandidate, ["list_files"]);
  const invalidProbeNotice = waitForWsMessage(invalidProbeCandidate, "error");
  const invalidProbeClosed = waitForWsClose(invalidProbeCandidate);
  invalidProbeCandidate.send(JSON.stringify({ type: "relay_probe_result", id: `${invalidProbe.id}-wrong` }));
  assert((await invalidProbeNotice).error === "invalid_relay_probe_result", "invalid readiness result returned the wrong protocol error");
  assert((await invalidProbeClosed).code === 1002, "invalid readiness result did not close with protocol-error status");
  const statusAfterInvalidProbe = await callServerInfo(base, ownerAccessToken, 211);
  assert(statusAfterInvalidProbe.daemon?.connected === true && statusAfterInvalidProbe.daemon?.tools?.includes("read_file"), "failed replacement readiness probe displaced the incumbent daemon");
  assert(firstStatus.tool_delivery?.host_exposed_tools_known_to_server === false, "Worker server_info incorrectly claimed host tool visibility");
  assert(firstStatus.tool_delivery?.host_may_expose_subset === true, "Worker server_info omitted host-side filtering boundary");
  assert(firstStatus.tool_delivery?.remote_process_delivery_mode === "durable_job"
    && firstStatus.tool_delivery?.remote_process_acceptance_max_ms === 10_000
    && firstStatus.tool_delivery?.remote_process_execution_timeout_max_ms === 600_000
    && firstStatus.tool_delivery?.managed_job_resource_admission_wait_max_ms === 1_800_000
    && firstStatus.tool_delivery?.remote_managed_job_read_wait_default_ms === 40_000
    && firstStatus.tool_delivery?.remote_managed_job_read_wait_max_ms === 60_000
    && firstStatus.tool_delivery?.remote_process_session_start_execution_max_ms === 10_000
    && firstStatus.tool_delivery?.tool_schema_generation === TOOL_SCHEMA_GENERATION
    && firstStatus.tool_delivery?.tool_schema_server_version === firstStatus.version
    && firstStatus.tool_delivery?.discovery_ttl_ms === 0
    && firstStatus.tool_delivery?.tool_list_ttl_ms === 0
    && firstStatus.tool_delivery?.host_visible_schema_known_to_server === false
    && firstStatus.tool_delivery?.host_schema_refresh_required_on_generation_change === true
    && firstStatus.tool_delivery?.host_turn_deadline_observable === false
    && firstStatus.tool_delivery?.managed_jobs_detached_from_mcp_response === true
    && !("remote_process_foreground_execution_max_ms" in firstStatus.tool_delivery),
  "Worker server_info lost schema freshness evidence or the separated durable-process acceptance/execution contract");

  const timedOutCandidate = await connectDaemon(base);
  daemonSockets.push(timedOutCandidate);
  const timeoutNotice = await waitForWsMessage(timedOutCandidate, "error", 15_000);
  assert(timeoutNotice.error === "daemon_hello_timeout", `unexpected candidate timeout error: ${timeoutNotice.error}`);
  const statusAfterCandidateTimeout = await callServerInfo(base, ownerAccessToken, 22);
  assert(statusAfterCandidateTimeout.daemon?.connected === true, "candidate hello timeout displaced the active daemon");
  assert(statusAfterCandidateTimeout.daemon?.tools?.includes("read_file"), "candidate hello timeout changed active daemon tools");
  if (timedOutCandidate.readyState === WebSocket.OPEN) {
    const expiredCandidateClosed = waitForWsClose(timedOutCandidate);
    timedOutCandidate.send(JSON.stringify({ type: "hello", tools: ["list_files"], policy: {} }));
    const expiredCloseInfo = await expiredCandidateClosed;
    assert(expiredCloseInfo.code === 1008, `expired candidate closed with unexpected code ${expiredCloseInfo.code}`);
  }

  const invalidCandidate = await connectDaemon(base);
  daemonSockets.push(invalidCandidate);
  const invalidCandidateClosed = waitForWsClose(invalidCandidate);
  invalidCandidate.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
  const invalidCloseInfo = await invalidCandidateClosed;
  assert(invalidCloseInfo.code === 1008, `pre-hello daemon message closed with unexpected code ${invalidCloseInfo.code}`);
  const statusAfterInvalidCandidate = await callServerInfo(base, ownerAccessToken, 23);
  assert(statusAfterInvalidCandidate.daemon?.connected === true, "invalid candidate displaced the active daemon");
  assert(statusAfterInvalidCandidate.daemon?.tools?.includes("read_file"), "invalid candidate changed active daemon tools");

  const invalidJsonCandidate = await connectDaemon(base);
  daemonSockets.push(invalidJsonCandidate);
  const invalidJsonNotice = waitForWsMessage(invalidJsonCandidate, "error");
  const invalidJsonClosed = waitForWsClose(invalidJsonCandidate);
  invalidJsonCandidate.send("{");
  assert((await invalidJsonNotice).error === "invalid_json", "invalid daemon JSON returned the wrong protocol error");
  assert((await invalidJsonClosed).code === 1007, "invalid daemon JSON did not close with invalid-payload status");

  const nonObjectCandidate = await connectDaemon(base);
  daemonSockets.push(nonObjectCandidate);
  const nonObjectNotice = waitForWsMessage(nonObjectCandidate, "error");
  const nonObjectClosed = waitForWsClose(nonObjectCandidate);
  nonObjectCandidate.send("null");
  assert((await nonObjectNotice).error === "invalid_message", "non-object daemon JSON returned the wrong protocol error");
  assert((await nonObjectClosed).code === 1002, "non-object daemon JSON did not close with protocol-error status");
  const missingInstanceCandidate = await connectDaemon(base);
  daemonSockets.push(missingInstanceCandidate);
  const missingInstanceNotice = waitForWsMessage(missingInstanceCandidate, "error");
  const missingInstanceClosed = waitForWsClose(missingInstanceCandidate);
  missingInstanceCandidate.send(JSON.stringify({ type: "hello", tools: ["list_dir"], policy: defaultDaemonPolicy() }));
  assert((await missingInstanceNotice).error === "invalid_daemon_instance", "missing daemon instance id returned the wrong protocol error");
  assert((await missingInstanceClosed).code === 1002, "missing daemon instance id did not close with protocol-error status");

  const statusAfterMalformedCandidates = await callServerInfo(base, ownerAccessToken, 231);
  assert(statusAfterMalformedCandidates.daemon?.connected === true, "malformed candidate displaced the active daemon");
  assert(statusAfterMalformedCandidates.daemon?.tools?.includes("read_file"), "malformed candidate changed active daemon tools");

  let candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const statusBeforeHello = await callServerInfo(base, ownerAccessToken, 24);
  assert(statusBeforeHello.daemon?.connected === true, "candidate connection displaced the active daemon before hello");
  assert(statusBeforeHello.daemon?.tools?.includes("read_file"), "candidate connection changed active tools before hello");

  const candidateInstanceId = nextDaemonInstanceId();
  const candidateTools = ["session_bootstrap", "resolve_task_capabilities", "list_dir", "view_image", "run_process", "exec_command", "start_job", "read_job"];
  const candidatePolicy = { profile: "agent", allowWrite: true, allowExec: true, execMode: "direct", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
  const firstClosed = waitForWsClose(firstDaemon);
  const replacementProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  const statusDuringProbe = await callServerInfo(base, ownerAccessToken, 241);
  assert(statusDuringProbe.daemon?.connected === true && statusDuringProbe.daemon?.tools?.includes("read_file"), "unverified replacement displaced the incumbent daemon");
  assert(statusDuringProbe.worker?.daemon_probes === 1, "server_info did not expose the in-progress readiness probe");
  assert(statusDuringProbe.worker?.sockets_live?.ready === 1 && statusDuringProbe.worker?.sockets_live?.probing === 1, "server_info conflated authenticated transport with verified readiness");
  await completeDaemonProbe(candidateDaemon, replacementProbe);
  const closeInfo = await firstClosed;
  assert(closeInfo.code === 1012, `replaced daemon closed with unexpected code ${closeInfo.code}`);
  const statusAfterHello = await callServerInfo(base, ownerAccessToken, 25);
  assert(statusAfterHello.daemon?.count === 1, `expected one active daemon after replacement, got ${statusAfterHello.daemon?.count}`);
  assert(statusAfterHello.daemon?.readiness_verified === true && statusAfterHello.worker?.sockets_live?.ready === 1, "verified daemon readiness was not observable");
  assert(statusAfterHello.daemon?.tools?.includes("list_dir"), "candidate daemon did not become active after hello");
  assert(statusAfterHello.daemon?.tools?.includes("view_image"), "candidate daemon image tool was not advertised");
  assert(statusAfterHello.daemon?.tools?.includes("run_process"), "agent policy did not retain direct process execution");
  assert(!statusAfterHello.daemon?.tools?.includes("exec_command"), "agent policy did not filter shell execution");
  assert(!statusAfterHello.daemon?.tools?.includes("read_file"), "replaced daemon tools remained active");

  const currentAgentTools = await currentMcpCall(base, ownerAccessToken, 9100, "tools/list", {});
  assert(currentAgentTools.response.status === 200
    && currentAgentTools.body.result?.resultType === "complete"
    && currentAgentTools.body.result?.tools?.some((tool) => tool.name === "run_process"),
  "current tools/list did not expose the authenticated stable catalog");

  const currentRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const currentToolPromise = currentMcpCall(base, ownerAccessToken, 9101, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const currentRelay = await currentRelayPromise;
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: currentRelay.id, ok: true, result: { current: true } }));
  const currentTool = await currentToolPromise;
  assert(currentTool.response.status === 200
    && currentTool.body.result?.resultType === "complete"
    && currentTool.body.result?.structuredContent?.current === true
    && currentTool.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version === pkg.version,
  "current tools/call lost resultType, structured content, or server identity");
  assert(currentTool.response.headers.get("mcp-session-id") === null, "current tool call minted a removed session");

  const malformedMessages = captureWsMessageTypes(candidateDaemon);
  const malformedCurrentTool = await currentMcpCall(base, ownerAccessToken, 9107, "tools/call", {
    name: "list_dir", arguments: { path: ".", unexpected: "must-not-dispatch" },
  });
  assert(malformedCurrentTool.body.error?.code === -32602
    && malformedCurrentTool.body.error?.data?.validation_issues?.[0]?.instancePath === "/unexpected",
  "current malformed tool arguments were not returned as Invalid params");
  assert(!malformedMessages.stop().includes("tool_call"), "current malformed tool arguments reached the daemon");
  const unknownMessages = captureWsMessageTypes(candidateDaemon);
  const unknownCurrentTool = await currentMcpCall(base, ownerAccessToken, 9108, "tools/call", {
    name: "missing_tool", arguments: {},
  });
  assert(unknownCurrentTool.body.error?.code === -32602, "current unknown tool was not returned as Invalid params");
  assert(!unknownMessages.stop().includes("tool_call"), "current unknown tool reached the daemon");

  const mismatchMessages = captureWsMessageTypes(candidateDaemon);
  const mismatchedName = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "read_file"),
    body: JSON.stringify(currentMcpRequest(9102, "tools/call", { name: "list_dir", arguments: { path: "." } })),
  });
  assert(mismatchedName.response.status === 400 && mismatchedName.body.error?.code === -32020,
    "current Mcp-Name/body mismatch was accepted");
  assert(!mismatchMessages.stop().includes("tool_call"), "header mismatch reached the daemon");

  const initializeMessages = captureWsMessageTypes(candidateDaemon);
  const currentInitialize = await currentMcpCall(base, ownerAccessToken, 9109, "initialize", {});
  assert(currentInitialize.response.status === 400 && currentInitialize.body.error?.code === -32601
    && currentInitialize.body.error?.data?.supported?.length === 1
    && currentInitialize.body.error.data.supported[0] === "2026-07-28",
  "removed HTTP initialize did not return bounded current-version upgrade guidance");
  assert(!initializeMessages.stop().includes("tool_call"), "removed HTTP initialize reached the daemon");

  const replayMarkerMessages = captureWsMessageTypes(candidateDaemon);
  const removedReplayMarker = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...currentMcpHeaders(ownerAccessToken, "tools/list"),
      "Last-Event-ID": "removed-replay-marker",
    },
    body: JSON.stringify(currentMcpRequest(9191, "tools/list", {})),
  });
  assert(removedReplayMarker.response.status === 400 && removedReplayMarker.body.error?.code === -32601
    && JSON.stringify(removedReplayMarker.body.error?.data?.supported) === JSON.stringify(["2026-07-28"]),
  "removed Last-Event-ID replay marker did not return bounded current-version upgrade guidance");
  assert(!replayMarkerMessages.stop().includes("tool_call"), "removed Last-Event-ID replay marker reached the daemon");

  const removedPing = await currentMcpCall(base, ownerAccessToken, 9103, "ping", {});
  assert(removedPing.response.status === 404 && removedPing.body.error?.code === -32601,
    "current HTTP retained removed ping semantics");

  const invalidSubscription = await currentMcpCall(base, ownerAccessToken, 9111, "subscriptions/listen", {});
  assert(invalidSubscription.response.status === 400 && invalidSubscription.body.error?.code === -32602,
    "current HTTP accepted a subscription without notifications");

  const subscriptionAbort = new AbortController();
  const subscriptionResponse = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "subscriptions/listen"),
    body: JSON.stringify(currentMcpRequest(9104, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    })),
    signal: subscriptionAbort.signal,
  });
  const subscriptionReader = subscriptionResponse.body.getReader();
  const subscriptionMessages = await readSseJsonMessages(subscriptionReader, 2);
  assert(subscriptionResponse.status === 200
      && subscriptionResponse.headers.get("content-type")?.startsWith("text/event-stream"),
  "current HTTP subscription did not use its request-scoped SSE response");
  assert(subscriptionMessages.length === 2
      && subscriptionMessages[0].method === "notifications/subscriptions/acknowledged"
      && subscriptionMessages[0].params?.notifications?.toolsListChanged === true,
  "current HTTP subscription did not acknowledge the supported toolsListChanged notification");
  assert(subscriptionMessages[0].params?._meta?.["io.modelcontextprotocol/subscriptionId"] === 9104
      && subscriptionMessages[1].method === "notifications/tools/list_changed"
      && subscriptionMessages[1].params?._meta?.["io.modelcontextprotocol/subscriptionId"] === 9104,
  "current HTTP subscription did not emit a correlated tool-list freshness edge");
  const activeSubscriptionStatus = await callServerInfo(base, ownerAccessToken, 9120);
  assert(activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_supported === true
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account === 1
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_opened_for_account === true
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_client_receipt_observable === false
      && activeSubscriptionStatus.tool_delivery?.tools_list_change_subscription_lease_ms === MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS,
  "server_info did not distinguish a server-opened toolsListChanged stream from unobservable client receipt");
  const pendingSubscriptionRead = subscriptionReader.read();
  assert(await Promise.race([
    pendingSubscriptionRead.then(() => "settled"),
    new Promise((resolve) => { setTimeout(() => resolve("open"), 25); }),
  ]) === "open", "current HTTP toolsListChanged subscription closed before its bounded server lease");
  subscriptionAbort.abort();
  const cancelledSubscriptionRead = await Promise.race([
    pendingSubscriptionRead.then((result) => ({ settled: true, done: result.done === true }), () => ({ settled: true, done: true })),
    sleep(1_000).then(() => ({ settled: false, done: false })),
  ]);
  assert(cancelledSubscriptionRead.settled && cancelledSubscriptionRead.done,
    "current HTTP request abort did not settle the subscription response body");
  let releasedSubscriptionStatus = await callServerInfo(base, ownerAccessToken, 9121);
  const releaseDeadline = Date.now() + MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS + 2_000;
  let releaseProbeId = 9122;
  while (releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account !== 0
      && Date.now() < releaseDeadline) {
    await sleep(250);
    releasedSubscriptionStatus = await callServerInfo(base, ownerAccessToken, releaseProbeId++);
  }
  assert(releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_active_for_account === 0
      && releasedSubscriptionStatus.tool_delivery?.tools_list_change_subscription_opened_for_account === true,
  "current HTTP request abort did not release Durable Object subscription capacity within the bounded server lease");
  const currentNotification = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "notifications/cancelled"),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        _meta: currentMcpRequest(0, "unused", {}).params._meta,
        requestId: 9105,
      },
    }),
  });
  assert(currentNotification.response.status === 404 && currentNotification.body.error?.code === -32601,
    "current HTTP accepted a stdio-only cancellation notification");

  const duplicateRelaySequence = waitForWsMessageSequence(candidateDaemon, ["tool_call", "tool_call"], 10_000);
  const duplicateCurrentA = currentMcpCall(base, ownerAccessToken, 9110, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const duplicateCurrentB = currentMcpCall(base, ownerAccessToken, 9110, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const [duplicateRelayA, duplicateRelayB] = await duplicateRelaySequence;
  assert(duplicateRelayA.id !== duplicateRelayB.id,
    "current HTTP requests sharing a JSON-RPC id reused an internal daemon call id");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: duplicateRelayA.id, ok: true, result: { request: "a" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: duplicateRelayB.id, ok: true, result: { request: "b" } }));
  const [duplicateResultA, duplicateResultB] = await Promise.all([duplicateCurrentA, duplicateCurrentB]);
  const duplicateValues = [
    duplicateResultA.body.result?.structuredContent?.request,
    duplicateResultB.body.result?.structuredContent?.request,
  ].sort();
  assert(JSON.stringify(duplicateValues) === JSON.stringify(["a", "b"]),
    "stateless current HTTP calls with the same request id conflicted or crossed results");

  const remoteAgentTools = await callToolsList(base, ownerAccessToken, 2501);
  const remoteRunProcess = remoteAgentTools.find((tool) => tool.name === "run_process");
  assert(remoteRunProcess?.inputSchema?.properties?.timeout_seconds?.maximum === 600
    && remoteRunProcess?.inputSchema?.properties?.timeout_seconds?.default === 600
    && remoteRunProcess?.inputSchema?.required?.includes("idempotency_key")
    && String(remoteRunProcess?.description || "").includes("one-step durable job")
    && String(remoteRunProcess?.description || "").includes("read_job"),
  "remote tools/list lost the durable-process execution and recovery contract");
  const remoteBrowserWait = remoteAgentTools.find((tool) => tool.name === "browser_wait");
  assert(remoteBrowserWait?.inputSchema?.properties?.timeout_seconds?.maximum === 45
    && remoteBrowserWait?.inputSchema?.properties?.timeout_seconds?.default === 20
    && remoteBrowserWait?.inputSchema?.required?.includes("tab_id")
    && String(remoteBrowserWait?.description || "").includes("explicit tab_id"),
  "remote tools/list lost the reply-safe browser timeout or explicit-tab concurrency contract");
  const remoteReadProcess = remoteAgentTools.find((tool) => tool.name === "read_process");
  const remoteReadProcessDescription = String(remoteReadProcess?.description || "");
  assert(remoteReadProcess?.inputSchema?.properties?.wait_ms?.maximum === 1000
    && remoteReadProcess?.inputSchema?.properties?.wait_ms?.default === 1000
    && remoteReadProcessDescription.includes("paced follow-up")
    && remoteReadProcessDescription.includes("wait_ms=0")
    && remoteReadProcessDescription.includes("same MCP call")
    && remoteReadProcessDescription.includes("next_blocking_poll_after_ms")
    && remoteReadProcessDescription.includes("must not busy-loop"),
  "remote tools/list lost the one-second server-paced process-follow-up contract");
  const remoteListJobsDescription = String(remoteAgentTools.find((tool) => tool.name === "list_jobs")?.description || "");
  assert(remoteListJobsDescription.includes("aggregate retained/capacity/activity state only")
    && remoteListJobsDescription.includes("deliberately omits job handles")
    && remoteListJobsDescription.includes("recovery_key")
    && remoteListJobsDescription.includes("do not repeat list_jobs"),
  "remote tools/list lost aggregate-only hosted managed-job inventory guidance");
  const overLimitMessages = captureWsMessageTypes(candidateDaemon);
  const overLimit = await callTool(base, ownerAccessToken, 2502, "run_process", {
    argv: ["must-not-run"], timeout_seconds: 601, idempotency_key: "worker-over-limit",
  });
  assert(!overLimitMessages.stop().includes("tool_call"),
    "over-limit JSON tool call reached the daemon before rejection");
  assert(overLimit.result?.isError === true
    && overLimit.result?.structuredContent?.error?.code === "invalid_request"
    && overLimit.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimit.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && overLimit.result?.structuredContent?.error?.details?.validation_issues?.some((issue) => issue.instancePath === "/timeout_seconds" && issue.keyword === "maximum"),
  "over-limit durable-process rejection omitted its stale-schema compatibility contract");

  const overLimitPollMessages = captureWsMessageTypes(candidateDaemon);
  const overLimitPoll = await callTool(base, ownerAccessToken, 25020, "read_process", {
    session_id: "proc_stale_schema", wait_ms: 6000,
  });
  assert(!overLimitPollMessages.stop().includes("tool_call"),
    "over-limit process poll reached the daemon before rejection");
  assert(overLimitPoll.result?.isError === true
    && overLimitPoll.result?.structuredContent?.error?.code === "invalid_request"
    && overLimitPoll.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimitPoll.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && overLimitPoll.result?.structuredContent?.error?.details?.validation_issues?.some((issue) => issue.instancePath === "/wait_ms" && issue.keyword === "maximum"),
  "over-limit process poll omitted its stale-schema compatibility contract");

  const malformedTimeoutMessages = captureWsMessageTypes(candidateDaemon);
  const malformedTimeout = await callTool(base, ownerAccessToken, 25021, "run_process", {
    argv: ["must-not-run"], timeout_seconds: "60", idempotency_key: "worker-malformed-timeout",
  });
  assert(!malformedTimeoutMessages.stop().includes("tool_call"),
    "malformed JSON foreground timeout reached the daemon before rejection");
  assert(malformedTimeout.error?.code === -32602
    && malformedTimeout.error?.data?.side_effects_started === false
    && malformedTimeout.error?.data?.validation_issues?.some((issue) => issue.instancePath === "/timeout_seconds" && issue.keyword === "type"),
  "malformed foreground timeout omitted its pre-dispatch schema contract");

  const missingNameMessages = captureWsMessageTypes(candidateDaemon);
  const missingName = await currentMcpCall(base, ownerAccessToken, 25022, "tools/call", { arguments: {} });
  assert(missingName.response.status === 400
    && !missingNameMessages.stop().includes("tool_call")
    && missingName.body.error?.code === -32602
    && missingName.body.error?.message === "name must be a string",
  "current tools/call without a name escaped pre-dispatch HTTP validation");

  const nonObjectArgumentsMessages = captureWsMessageTypes(candidateDaemon);
  const nonObjectArguments = await callTool(base, ownerAccessToken, 25023, "list_dir", []);
  assert(!nonObjectArgumentsMessages.stop().includes("tool_call")
    && nonObjectArguments.error?.code === -32602
    && nonObjectArguments.error?.data?.side_effects_started === false
    && nonObjectArguments.error?.data?.validation_issues?.some((issue) => issue.instancePath === "" && issue.keyword === "type"),
  "removed tools/call silently coerced non-object arguments");

  const overLimitStreamMessages = captureWsMessageTypes(candidateDaemon);
  const overLimitStream = await currentMcpCall(base, ownerAccessToken, 2503, "tools/call", {
    name: "run_process", arguments: { argv: ["must-not-stream-run"], timeout_seconds: 601, idempotency_key: "worker-stream-over-limit" },
  });
  assert(!overLimitStreamMessages.stop().includes("tool_call"),
    "over-limit streamed tool call reached the daemon before rejection");
  assert(overLimitStream.body.result?.isError === true
    && overLimitStream.body.result?.structuredContent?.error?.code === "invalid_request"
    && overLimitStream.body.result?.structuredContent?.error?.details?.side_effects_started === false
    && overLimitStream.body.result?.structuredContent?.error?.details?.schema_refresh_recommended === true,
  "stale-schema current tool call omitted its pre-dispatch compatibility contract");

  const missingRecoveryKeyMessages = captureWsMessageTypes(candidateDaemon);
  const missingRecoveryKey = await callTool(base, ownerAccessToken, 25031, "run_process", {
    argv: ["must-not-run"], timeout_seconds: 10,
  });
  assert(!missingRecoveryKeyMessages.stop().includes("tool_call"),
    "durable process without a caller-held recovery key reached the daemon");
  assert(missingRecoveryKey.result?.isError === true
    && missingRecoveryKey.result?.structuredContent?.error?.code === "invalid_request"
    && missingRecoveryKey.result?.structuredContent?.error?.details?.side_effects_started === false
    && missingRecoveryKey.result?.structuredContent?.error?.details?.schema_refresh_recommended === true
    && missingRecoveryKey.result?.structuredContent?.error?.details?.recovery_credential_required === "idempotency_key",
  "missing durable-process recovery credential did not return a stale-schema-safe no-side-effect error");

  const streamedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const streamedResponsePromise = stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "list_dir"),
    body: JSON.stringify(currentMcpRequest(879, "tools/call", { name: "list_dir", arguments: { path: "." } })),
  });
  const streamedRelay = await streamedRelayPromise;
  const streamedResponse = await streamedResponsePromise;
  assert(streamedResponse.status === 200 && streamedResponse.headers.get("content-type")?.startsWith("text/event-stream"),
    "current event-stream request did not use request-scoped SSE");
  const streamedReader = streamedResponse.body.getReader();
  const streamedInitial = new TextDecoder().decode((await streamedReader.read()).value);
  assert(streamedInitial === ": connected\n\n", "current response stream exposed a replay/session event id");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: streamedRelay.id, ok: true, result: { streamed: true } }));
  const streamedEnvelope = await readSseJsonRpcResponse(streamedReader, streamedInitial);
  assert(streamedEnvelope.message.result?.structuredContent?.streamed === true
    && streamedEnvelope.eventIds.length === 0,
  "current streamed tool call lost its result or regained replay event ids");

  const removedGet = await stableFetch(`${base}/mcp`, {
    method: "GET",
    headers: { authorization: `Bearer ${ownerAccessToken}`, "MCP-Protocol-Version": "2026-07-28", "Last-Event-ID": "removed" },
  });
  assert(removedGet.status === 405 && removedGet.headers.get("allow") === "POST",
    "removed GET/Last-Event-ID resumption path was still served");

  const firstWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const firstWindowCall = toolCallRequest(base, ownerAccessToken, 880, "list_dir", { path: "." });
  const firstWindowRelay = await firstWindowRelayPromise;
  const secondWindowRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const secondWindowCall = toolCallRequest(base, ownerAccessToken, 880, "list_dir", { path: "." });
  const secondWindowRelay = await secondWindowRelayPromise;
  assert(firstWindowRelay.id !== secondWindowRelay.id, "two MCP request streams reused an internal daemon call id");
  const concurrentStatus = await callServerInfo(base, ownerAccessToken, 8810);
  assert(concurrentStatus.worker?.pending_calls?.active === 2, "Worker did not retain two concurrent request-scoped calls");
  assert(concurrentStatus.worker?.pending_calls?.request_keys === 2, "Worker did not isolate concurrent request-stream keys");
  assert(concurrentStatus.worker?.pending_calls?.by_tool?.list_dir === 2, "pending-call diagnostics omitted concurrent tool counts");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: secondWindowRelay.id, ok: true, result: { window: "second" } }));
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: firstWindowRelay.id, ok: true, result: { window: "first" } }));
  const [firstWindowResult, secondWindowResult] = await Promise.all([firstWindowCall, secondWindowCall]);
  assert(firstWindowResult.body.result?.structuredContent?.window === "first", "first MCP request stream received another request's result");
  assert(secondWindowResult.body.result?.structuredContent?.window === "second", "second MCP request stream received another request's result");

  const handoverRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const handoverCall = toolCallRequest(base, ownerAccessToken, 8799, "list_dir", { path: "." });
  const handoverRelay = await handoverRelayPromise;
  const handoverPreviousSocket = candidateDaemon;
  const handoverPreviousClosed = waitForWsClose(handoverPreviousSocket);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const handoverResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(handoverResume.ids.length === 1 && handoverResume.ids[0] === handoverRelay.id, "verified same-instance socket handover did not transfer the attached call before closing the incumbent");
  await handoverPreviousClosed;
  const handoverStatus = await callServerInfo(base, ownerAccessToken, 87990);
  assert(handoverStatus.worker?.pending_calls?.active === 1 && handoverStatus.worker?.pending_calls?.detached === 0, "verified socket handover left the transferred call detached");
  const handoverResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: handoverRelay.id, ok: true, result: { handover: true } }));
  assert((await handoverResultAck).id === handoverRelay.id, "transferred call result was not acknowledged");
  assert((await handoverCall).body.result?.structuredContent?.handover === true, "transferred call did not complete on the verified replacement socket");

  const duplicateResultBaseline = await callServerInfo(base, ownerAccessToken, 87991);
  const baselineOwnerMissing = duplicateResultBaseline.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0;
  const baselineStaleRejected = duplicateResultBaseline.worker?.observability?.terminal_results?.stale_connection_rejected ?? 0;
  const duplicateResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: handoverRelay.id, ok: true, result: { handover: true } }));
  assert((await duplicateResultAck).id === handoverRelay.id, "duplicate terminal result was not acknowledged");
  let duplicateResultStatus = duplicateResultBaseline;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    duplicateResultStatus = await callServerInfo(base, ownerAccessToken, 87992 + attempt);
    if ((duplicateResultStatus.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) > baselineOwnerMissing) break;
    await sleep(25);
  }
  assert((duplicateResultStatus.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) === baselineOwnerMissing + 1,
    "duplicate terminal result was not classified as owner-missing and acknowledged");
  assert((duplicateResultStatus.worker?.observability?.terminal_results?.stale_connection_rejected ?? 0) === baselineStaleRejected,
    "duplicate terminal result was misclassified as a stale-connection rejection");

  const reconnectRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reconnectCall = toolCallRequest(base, ownerAccessToken, 8801, "list_dir", { path: "." });
  const reconnectRelay = await reconnectRelayPromise;
  const disconnectedCandidate = candidateDaemon;
  const disconnectedCandidateClosed = waitForWsClose(disconnectedCandidate);
  disconnectedCandidate.terminate();
  await disconnectedCandidateClosed;
  const detachedStatus = await callServerInfo(base, ownerAccessToken, 8802);
  assert(detachedStatus.worker?.pending_calls?.active === 1, "transient daemon disconnect lost the pending MCP request");
  assert(detachedStatus.worker?.pending_calls?.detached === 1, "pending request was not marked detached during reconnect grace");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const resumedCalls = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(resumedCalls.ids.length === 1 && resumedCalls.ids[0] === reconnectRelay.id, "Worker did not authorize exactly the detached call during reconnect");
  const reboundStatus = await callServerInfo(base, ownerAccessToken, 8803);
  assert(reboundStatus.worker?.pending_calls?.active === 1, "same daemon instance reconnect did not retain the pending request");
  assert(reboundStatus.worker?.pending_calls?.detached === 0, "same daemon instance reconnect did not rebind the pending request");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: reconnectRelay.id, ok: true, result: { resumed: true } }));
  const reconnectResult = await reconnectCall;
  assert(reconnectResult.body.result?.structuredContent?.resumed === true, "MCP request did not complete after same-instance daemon reconnect");

  const plannedDrainJobId = `job_${"d".repeat(64)}`;
  const plannedDrainAcceptanceRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const plannedDrainAcceptanceCall = toolCallRequest(base, ownerAccessToken, 88030, "start_job", {
    idempotency_key: "planned-drain-capability", steps: [{ argv: ["true"] }],
  });
  const plannedDrainAcceptanceRelay = await plannedDrainAcceptanceRelayPromise;
  assert(plannedDrainAcceptanceRelay.tool === "start_job"
    && !("recovery_key" in plannedDrainAcceptanceRelay.arguments)
    && !("control_key" in plannedDrainAcceptanceRelay.arguments),
  "hosted managed-job capability material crossed the Worker/daemon request boundary");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: plannedDrainAcceptanceRelay.id, ok: true,
    result: { accepted: true, job_id: plannedDrainJobId, status: "running", recovery: { tool: "read_job", job_id: plannedDrainJobId } },
  }));
  const plannedDrainAcceptanceResult = await plannedDrainAcceptanceCall;
  const plannedDrainRecoveryKey = plannedDrainAcceptanceResult.body.result?.structuredContent?.recovery_key;
  assert(typeof plannedDrainRecoveryKey === "string" && /^mcp_jr_[A-Za-z0-9_-]{43}$/.test(plannedDrainRecoveryKey),
    "hosted managed-job acceptance did not return a read recovery capability");
  const plannedDrainRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const plannedDrainCall = toolCallRequest(base, ownerAccessToken, 88031, "read_job", {
    job_id: plannedDrainJobId, recovery_key: plannedDrainRecoveryKey, wait_ms: 0,
  });
  const plannedDrainRelay = await plannedDrainRelayPromise;
  assert(plannedDrainRelay.arguments?.job_id === plannedDrainJobId && !("recovery_key" in plannedDrainRelay.arguments),
    "hosted read_job forwarded its recovery capability to the daemon");
  const plannedDrainBaseline = await callServerInfo(base, ownerAccessToken, 88032);
  const plannedDrainAckPromise = waitForWsMessage(candidateDaemon, "daemon_draining_ack");
  const plannedDrainId = `drain_${"p".repeat(24)}`;
  candidateDaemon.send(JSON.stringify({ type: "daemon_draining", drain_id: plannedDrainId, active_calls: 1 }));
  assert((await plannedDrainAckPromise).drain_id === plannedDrainId,
    "planned daemon drain was not acknowledged before the daemon transport closed");
  const plannedDrainResult = await plannedDrainCall;
  const plannedDrainError = plannedDrainResult.body.result?.structuredContent?.error;
  assert(plannedDrainResult.body.result?.isError === true
    && plannedDrainError?.code === "unavailable"
    && plannedDrainError?.retryable === true
    && plannedDrainError?.details?.reason === "daemon_planned_drain"
    && plannedDrainError?.details?.side_effects_started === false
    && plannedDrainError?.details?.recovery?.mode === "read_same_job"
    && plannedDrainError?.details?.recovery?.job_id === plannedDrainJobId,
  "planned daemon drain did not convert an active read_job into a structured same-job recovery settlement");
  const plannedDrainStatus = await callServerInfo(base, ownerAccessToken, 88033);
  assert((plannedDrainStatus.worker?.observability?.continuity?.planned_drains ?? 0)
      === (plannedDrainBaseline.worker?.observability?.continuity?.planned_drains ?? 0) + 1
    && (plannedDrainStatus.worker?.observability?.continuity?.planned_drain_calls ?? 0)
      === (plannedDrainBaseline.worker?.observability?.continuity?.planned_drain_calls ?? 0) + 1
    && plannedDrainStatus.daemon?.connected === false,
  "Worker isolate-local continuity diagnostics did not record the planned drain settlement");

  const drainedCandidate = candidateDaemon;
  const drainedCandidateClosed = waitForWsClose(drainedCandidate);
  drainedCandidate.terminate();
  await drainedCandidateClosed;
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const postDrainResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(postDrainResume.ids.length === 0, "planned drain left an old pending call eligible for same-instance resume");
  const postDrainStatus = await callServerInfo(base, ownerAccessToken, 88034);
  assert((postDrainStatus.worker?.continuity_evidence?.planned_drains ?? 0)
      === (plannedDrainBaseline.worker?.continuity_evidence?.planned_drains ?? 0) + 1
    && (postDrainStatus.worker?.continuity_evidence?.planned_drain_calls ?? 0)
      === (plannedDrainBaseline.worker?.continuity_evidence?.planned_drain_calls ?? 0) + 1
    && postDrainStatus.worker?.continuity_evidence?.last_planned_drain_at,
  "Worker durable continuity evidence did not survive the planned-drain reconnect boundary");

  const lateResultRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const lateResultCall = toolCallRequest(base, ownerAccessToken, 8870, "session_bootstrap", { path: "." });
  const lateResultRelay = await lateResultRelayPromise;
  const lateResultSocket = candidateDaemon;
  const lateResultSocketClosed = waitForWsClose(lateResultSocket);
  lateResultSocket.terminate();
  await lateResultSocketClosed;
  await new Promise((resolve) => { setTimeout(resolve, 15_500); });
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const lateResultProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  const lateResultResume = await completeDaemonProbe(candidateDaemon, lateResultProbe);
  assert(lateResultResume.ids.includes(lateResultRelay.id),
    "same-instance reconnect discarded the pending result owner at its original settlement deadline");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: lateResultRelay.id, ok: true,
    result: { late_reconnect_result: true },
  }));
  const lateResultSettled = await lateResultCall;
  assert(lateResultSettled.body.result?.structuredContent?.late_reconnect_result === true,
    "terminal result arriving after the original settlement deadline did not settle the original MCP request");

  const fallbackRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const fallbackCall = toolCallRequest(base, ownerAccessToken, 8880, "list_dir", { path: "." });
  const fallbackRelay = await fallbackRelayPromise;
  const fallbackBaseline = await callServerInfo(base, ownerAccessToken, 8881);
  const fallbackOwnerMissing = fallbackBaseline.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0;
  const fallbackPreviousSocket = candidateDaemon;
  const fallbackPreviousClosed = waitForWsClose(fallbackPreviousSocket);
  fallbackPreviousSocket.terminate();
  await fallbackPreviousClosed;

  const fallbackSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const fallbackBase = {
    protocol: 1,
    session_id: fallbackSessionId,
    instance_id: candidateInstanceId,
    ack_worker_seq: 0,
    owned_call_ids: [fallbackRelay.id],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: {
      schema_version: 1, transport: "https", network_route: "system-network-stack",
      outage_count: 1, outage_active: true, outage_duration_ms: 1,
    },
  };
  const fallbackProbing = await daemonHttpExchange(fallbackBase);
  assert(fallbackProbing.response.status === 200
    && fallbackProbing.body.phase === "probing"
    && /^activate_[A-Za-z0-9_-]{43}$/.test(fallbackProbing.body.activation_token || ""),
  "signed HTTPS fallback did not enter bounded probing on its first authenticated exchange");
  const fallbackResume = fallbackProbing.body.messages?.find((message) => message.payload?.type === "resume_calls")?.payload;
  const fallbackReadyAck = fallbackProbing.body.messages?.find((message) => message.payload?.type === "ready_ack")?.payload;
  assert(fallbackResume?.ids?.length === 1 && fallbackResume.ids[0] === fallbackRelay.id,
    "HTTPS fallback did not rebind exactly the same-instance in-flight call");
  assert(fallbackReadyAck?.server === "machine-bridge-mcp" && fallbackReadyAck?.version === pkg.version,
    "HTTPS fallback omitted the verified ready acknowledgement");
  const fallbackProbeStatus = await callServerInfo(base, ownerAccessToken, 8882);
  assert(fallbackProbeStatus.worker?.sockets_live?.https_fallback_ready === 0
    && fallbackProbeStatus.daemon?.connected === false,
  "probing HTTPS fallback was advertised as ready before the local runtime proved ready_ack delivery");
  const ackWorkerSeq = Math.max(...fallbackProbing.body.messages.map((message) => message.seq));
  const fallbackVerified = await daemonHttpExchange({
    ...fallbackBase,
    activation_token: fallbackProbing.body.activation_token,
    ack_worker_seq: ackWorkerSeq,
    messages: [
      { seq: 1, payload: { type: "https_ready" } },
      { seq: 2, payload: { type: "resume_calls_ack", missing_ids: [] } },
    ],
  });
  assert(fallbackVerified.response.status === 200 && fallbackVerified.body.phase === "ready"
    && fallbackVerified.body.ack_daemon_seq === 2,
  "HTTPS fallback did not become ready after explicit local verified-ready proof");
  const fallbackReadyStatus = await callServerInfo(base, ownerAccessToken, 8882);
  assert(fallbackReadyStatus.worker?.sockets_live?.https_fallback_ready === 1
    && fallbackReadyStatus.daemon?.connected === true,
  "server_info did not report the ready HTTPS daemon fallback");

  const fallbackResultExchange = {
    ...fallbackBase,
    activation_token: fallbackProbing.body.activation_token,
    ack_worker_seq: ackWorkerSeq,
    messages: [{ seq: 3, payload: { type: "tool_result", id: fallbackRelay.id, ok: true, result: { https_fallback: true } } }],
  };
  const lostFallbackResponse = await daemonHttpExchange(fallbackResultExchange);
  assert(lostFallbackResponse.response.status === 200 && lostFallbackResponse.body.ack_daemon_seq === 3,
    "HTTPS fallback did not commit the first daemon result sequence");
  const fallbackResult = await fallbackCall;
  assert(fallbackResult.body.result?.structuredContent?.https_fallback === true,
    "MCP request did not settle through the HTTPS fallback");
  const replayedFallbackResponse = await daemonHttpExchange(fallbackResultExchange);
  assert(replayedFallbackResponse.response.status === 200 && replayedFallbackResponse.body.ack_daemon_seq === 3,
    "lost HTTPS response retry did not converge on the already-committed daemon sequence");
  const fallbackAfterReplay = await callServerInfo(base, ownerAccessToken, 8883);
  assert((fallbackAfterReplay.worker?.observability?.terminal_results?.owner_missing_acknowledged ?? 0) === fallbackOwnerMissing,
    "replayed HTTPS transport sequence re-entered tool-result handling instead of being deduplicated");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const fallbackHandoverProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, fallbackHandoverProbe);
  const fallbackHandoverStatus = await callServerInfo(base, ownerAccessToken, 8884);
  assert(fallbackHandoverStatus.worker?.sockets_live?.ready === 1
    && fallbackHandoverStatus.worker?.sockets_live?.https_fallback_ready === 0,
  "verified WebSocket did not reclaim primary daemon ownership from HTTPS fallback");
  const fallbackStandby = await daemonHttpExchange(fallbackResultExchange);
  assert(fallbackStandby.response.status === 409 && fallbackStandby.body.error === "unknown_daemon_http_session",
    "superseded HTTPS fallback session was not rejected after verified WSS reclaimed ownership");

  const staleTakeoverConnectionId = candidateDaemon.mbmWelcome?.connection_id;
  assert(/^connection_[A-Za-z0-9_-]{43}$/.test(String(staleTakeoverConnectionId || "")),
    "Worker welcome did not expose the connection identity required for generation-bound fallback takeover");
  const stalePreviousSocket = candidateDaemon;
  const stalePreviousClosed = waitForWsClose(stalePreviousSocket);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const recoveredProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, recoveredProbe);
  await stalePreviousClosed;
  const staleTakeoverSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const staleTakeover = await daemonHttpExchange({
    protocol: 1,
    session_id: staleTakeoverSessionId,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    takeover_websocket_connection_id: staleTakeoverConnectionId,
    ack_worker_seq: 0,
    owned_call_ids: [],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  });
  assert(staleTakeover.response.status === 200 && staleTakeover.body.phase === "standby",
    "stale HTTPS takeover was not fenced off after a newer same-instance WebSocket became ready");
  const afterStaleTakeover = await callServerInfo(base, ownerAccessToken, 8885);
  assert(afterStaleTakeover.worker?.sockets_live?.ready === 1
    && afterStaleTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "stale HTTPS takeover retired the newer verified WebSocket generation");
  const legacyTakeover = await daemonHttpExchange({
    protocol: 1,
    session_id: `relay_http_${randomBytes(32).toString("base64url")}`,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    ack_worker_seq: 0,
    owned_call_ids: [],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  });
  assert(legacyTakeover.response.status === 400 && legacyTakeover.body.error === "invalid_daemon_http_exchange",
    "generation-less HTTPS takeover remained accepted after its rolling compatibility boundary expired");
  const afterLegacyTakeover = await callServerInfo(base, ownerAccessToken, 8886);
  assert(afterLegacyTakeover.worker?.sockets_live?.ready === 1
    && afterLegacyTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "rejected generation-less HTTPS takeover changed verified WebSocket ownership");

  const asymmetricRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const asymmetricCall = toolCallRequest(base, ownerAccessToken, 8890, "list_dir", { path: "." });
  const asymmetricRelay = await asymmetricRelayPromise;
  const asymmetricSessionId = `relay_http_${randomBytes(32).toString("base64url")}`;
  const asymmetricBase = {
    protocol: 1,
    session_id: asymmetricSessionId,
    instance_id: candidateInstanceId,
    takeover_websocket: true,
    takeover_websocket_connection_id: candidateDaemon.mbmWelcome.connection_id,
    ack_worker_seq: 0,
    owned_call_ids: [asymmetricRelay.id],
    messages: [],
    tools: candidateTools,
    policy: candidatePolicy,
    relay_diagnostics: { schema_version: 1, transport: "https", outage_active: true, outage_count: 1 },
  };
  const invalidTakeover = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: `activate_${"z".repeat(43)}`,
  });
  assert(invalidTakeover.response.status === 409,
    "invalid new HTTPS takeover session was not rejected before transport ownership changed");
  const afterInvalidTakeover = await callServerInfo(base, ownerAccessToken, 8890);
  assert(afterInvalidTakeover.worker?.sockets_live?.ready === 1
    && afterInvalidTakeover.worker?.sockets_live?.https_fallback_ready === 0,
  "invalid signed HTTPS takeover request retired the healthy WebSocket before candidate validation");

  const asymmetricPreviousSocket = candidateDaemon;
  const asymmetricPreviousClosed = waitForWsClose(asymmetricPreviousSocket);
  const asymmetricProbing = await daemonHttpExchange(asymmetricBase);
  assert(asymmetricProbing.response.status === 200 && asymmetricProbing.body.phase === "probing",
    "authenticated same-instance HTTPS takeover was blocked by the Worker-side zombie WebSocket");
  await asymmetricPreviousClosed;
  const asymmetricResume = asymmetricProbing.body.messages?.find((message) => message.payload?.type === "resume_calls")?.payload;
  assert(asymmetricResume?.ids?.length === 1 && asymmetricResume.ids[0] === asymmetricRelay.id,
    "same-instance HTTPS takeover lost the in-flight WebSocket call during ownership transfer");
  const asymmetricAckWorkerSeq = Math.max(...asymmetricProbing.body.messages.map((message) => message.seq));
  const asymmetricVerified = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: asymmetricProbing.body.activation_token,
    ack_worker_seq: asymmetricAckWorkerSeq,
    messages: [
      { seq: 1, payload: { type: "https_ready" } },
      { seq: 2, payload: { type: "resume_calls_ack", missing_ids: [] } },
    ],
  });
  assert(asymmetricVerified.response.status === 200 && asymmetricVerified.body.phase === "ready",
    "same-instance HTTPS takeover did not finish verified readiness after retiring the zombie WebSocket");
  const asymmetricResult = await daemonHttpExchange({
    ...asymmetricBase,
    activation_token: asymmetricProbing.body.activation_token,
    ack_worker_seq: asymmetricAckWorkerSeq,
    messages: [{ seq: 3, payload: {
      type: "tool_result", id: asymmetricRelay.id, ok: true, result: { asymmetric_https_takeover: true },
    } }],
  });
  assert(asymmetricResult.response.status === 200 && asymmetricResult.body.ack_daemon_seq === 3,
    "same-instance HTTPS takeover did not acknowledge the transferred call result");
  const asymmetricSettled = await asymmetricCall;
  assert(asymmetricSettled.body.result?.structuredContent?.asymmetric_https_takeover === true,
    "in-flight call did not settle after asymmetric WebSocket-to-HTTPS takeover");

  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const asymmetricReturnProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  await completeDaemonProbe(candidateDaemon, asymmetricReturnProbe);
  const asymmetricReturnStatus = await callServerInfo(base, ownerAccessToken, 8891);
  assert(asymmetricReturnStatus.worker?.sockets_live?.ready === 1
    && asymmetricReturnStatus.worker?.sockets_live?.https_fallback_ready === 0,
  "WebSocket did not reclaim primary ownership after asymmetric HTTPS takeover recovery");

  const missingOwnershipRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const missingOwnershipCall = toolCallRequest(base, ownerAccessToken, 8804, "list_dir", { path: "." });
  const missingOwnershipRelay = await missingOwnershipRelayPromise;
  const missingOwnershipPreviousSocket = candidateDaemon;
  const missingOwnershipPreviousClosed = waitForWsClose(missingOwnershipPreviousSocket);
  missingOwnershipPreviousSocket.terminate();
  await missingOwnershipPreviousClosed;
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const missingOwnershipResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(missingOwnershipResume.ids.length === 1 && missingOwnershipResume.ids[0] === missingOwnershipRelay.id,
    "same-instance reconnect did not carry the simulated undelivered call into resume reconciliation");
  const missingOwnershipRedelivery = waitForWsMessage(candidateDaemon, "tool_call");
  candidateDaemon.send(JSON.stringify({
    type: "resume_calls_ack",
    missing_ids: [missingOwnershipRelay.id],
  }));
  const redeliveredMissingOwnership = await missingOwnershipRedelivery;
  assert(redeliveredMissingOwnership.id === missingOwnershipRelay.id
    && redeliveredMissingOwnership.tool === missingOwnershipRelay.tool
    && JSON.stringify(redeliveredMissingOwnership.arguments) === JSON.stringify(missingOwnershipRelay.arguments)
    && Number.isInteger(redeliveredMissingOwnership.timeout_ms)
    && redeliveredMissingOwnership.timeout_ms > 0
    && redeliveredMissingOwnership.timeout_ms <= missingOwnershipRelay.timeout_ms,
  "daemon-proven non-delivery did not redeliver the exact original call inside its remaining execution budget");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: missingOwnershipRelay.id, ok: true,
    result: { proven_non_delivery_redelivered: true },
  }));
  const missingOwnershipResult = await missingOwnershipCall;
  assert(missingOwnershipResult.response.status === 200
    && missingOwnershipResult.body.result?.isError !== true
    && missingOwnershipResult.body.result?.structuredContent?.proven_non_delivery_redelivered === true,
  "daemon-proven non-delivery did not recover transparently through one safe same-id transport redelivery");

  const lowHeadroomReadRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const lowHeadroomReadCall = toolCallRequest(base, ownerAccessToken, 88042, "read_job", {
    job_id: plannedDrainJobId, recovery_key: plannedDrainRecoveryKey, wait_ms: 0,
  });
  const lowHeadroomReadRelay = await lowHeadroomReadRelayPromise;
  assert(lowHeadroomReadRelay.tool === "read_job"
    && lowHeadroomReadRelay.arguments?.job_id === plannedDrainJobId
    && lowHeadroomReadRelay.arguments?.wait_ms === 0
    && lowHeadroomReadRelay.timeout_ms === 10_000,
  "immediate managed-job checkpoint did not start with the expected ten-second execution budget");
  const lowHeadroomPreviousSocket = candidateDaemon;
  const lowHeadroomPreviousClosed = waitForWsClose(lowHeadroomPreviousSocket);
  lowHeadroomPreviousSocket.terminate();
  await lowHeadroomPreviousClosed;
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const lowHeadroomResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(lowHeadroomResume.ids.includes(lowHeadroomReadRelay.id),
    "same-instance reconnect did not retain the immediate read_job for resume reconciliation");
  const lowHeadroomRedeliveryPromise = waitForWsMessage(candidateDaemon, "tool_call");
  candidateDaemon.send(JSON.stringify({
    type: "resume_calls_ack", missing_ids: [lowHeadroomReadRelay.id],
  }));
  const lowHeadroomRedelivery = await lowHeadroomRedeliveryPromise;
  assert(lowHeadroomRedelivery.id === lowHeadroomReadRelay.id
    && lowHeadroomRedelivery.tool === "read_job"
    && lowHeadroomRedelivery.arguments?.job_id === plannedDrainJobId
    && lowHeadroomRedelivery.arguments?.wait_ms === 0
    && Number.isInteger(lowHeadroomRedelivery.timeout_ms)
    && lowHeadroomRedelivery.timeout_ms >= 1_000
    && lowHeadroomRedelivery.timeout_ms < lowHeadroomReadRelay.timeout_ms,
  "daemon-proven immediate read_job non-delivery was not salvaged as a zero-wait checkpoint inside the remaining budget");
  const duplicateMissingMessages = captureWsMessageTypes(candidateDaemon);
  candidateDaemon.send(JSON.stringify({
    type: "resume_calls_ack", missing_ids: [lowHeadroomReadRelay.id],
  }));
  await sleep(250);
  assert(!duplicateMissingMessages.stop().includes("tool_call"),
    "duplicate missing acknowledgement replayed a call that had already used its one transport redelivery");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result", id: lowHeadroomReadRelay.id, ok: true,
    result: { job_id: plannedDrainJobId, status: "succeeded", result: { low_headroom_redelivery: true } },
  }));
  const lowHeadroomReadResult = await lowHeadroomReadCall;
  assert(lowHeadroomReadResult.response.status === 200
    && lowHeadroomReadResult.body.result?.isError !== true
    && lowHeadroomReadResult.body.result?.structuredContent?.status === "succeeded",
  "low-headroom read_job redelivery did not settle the original MCP request");

  const expiredRedeliveryRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const expiredRedeliveryCall = toolCallRequest(base, ownerAccessToken, 88041, "session_bootstrap", { path: "." });
  const expiredRedeliveryRelay = await expiredRedeliveryRelayPromise;
  const expiredRedeliveryPreviousSocket = candidateDaemon;
  const expiredRedeliveryPreviousClosed = waitForWsClose(expiredRedeliveryPreviousSocket);
  expiredRedeliveryPreviousSocket.terminate();
  await expiredRedeliveryPreviousClosed;
  await new Promise((resolve) => { setTimeout(resolve, 10_500); });
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const expiredRedeliveryResume = await sendDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  assert(expiredRedeliveryResume.ids.includes(expiredRedeliveryRelay.id),
    "result-delivery grace did not retain the call owner after the original execution budget elapsed");
  const expiredRedeliveryMessages = captureWsMessageTypes(candidateDaemon);
  candidateDaemon.send(JSON.stringify({
    type: "resume_calls_ack",
    missing_ids: [expiredRedeliveryRelay.id],
  }));
  const expiredRedeliveryResult = await expiredRedeliveryCall;
  const expiredRedeliveryError = expiredRedeliveryResult.body.result?.structuredContent?.error;
  await new Promise((resolve) => { setTimeout(resolve, 25); });
  assert(expiredRedeliveryResult.body.result?.isError === true
    && expiredRedeliveryError?.code === "unavailable"
    && expiredRedeliveryError?.retryable === true
    && expiredRedeliveryError?.details?.side_effects_started === false
    && expiredRedeliveryError?.details?.reason === "daemon_call_not_received_after_reconnect"
    && !expiredRedeliveryMessages.stop().includes("tool_call"),
  "extended result settlement incorrectly authorized a new daemon execution after the original execution deadline");

  const idlessMessages = captureWsMessageTypes(candidateDaemon);
  const idlessBody = currentMcpRequest(250, "tools/call", { name: "server_info", arguments: {} });
  delete idlessBody.id;
  const idlessToolCall = await fetchJson(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(ownerAccessToken, "tools/call", "server_info"),
    body: JSON.stringify(idlessBody),
  });
  assert(idlessToolCall.response.status === 404 && idlessToolCall.body.error?.code === -32601
    && !idlessMessages.stop().includes("tool_call"),
  "Worker accepted tools/call as a notification or dispatched it without a request id");

  // Keep this long integration suite from turning the production per-credential 120/60s limiter into a CI timing oracle.
  // Rate-limit keys/429 behavior have dedicated tests; this phase only needs the same owner authority on fresh credentials.
  const ownerPhaseRefresh = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: ownerRefreshToken,
      client_id: registration.body.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(ownerPhaseRefresh.response.status === 200
    && typeof ownerPhaseRefresh.body.access_token === "string"
    && ownerPhaseRefresh.body.access_token !== ownerAccessToken
    && typeof ownerPhaseRefresh.body.refresh_token === "string"
    && ownerPhaseRefresh.body.refresh_token !== ownerRefreshToken,
  "owner phase-boundary refresh did not rotate the integration credentials");
  ownerAccessToken = ownerPhaseRefresh.body.access_token;

  const activeTools = await callToolsList(base, ownerAccessToken, 26);
  assert(JSON.stringify(activeTools.map((tool) => tool.name).sort()) === JSON.stringify(stableOwnerToolNames),
    "verified daemon replacement changed the stable owner tool catalog");
  assert(activeTools.some((tool) => tool.name === "read_file"), "stable owner catalog omitted a policy-gated tool");
  assert(activeTools.find((tool) => tool.name === "list_dir")?.annotations?.readOnlyHint === true, "tool annotations were not returned");

  const reviewerTools = await callToolsList(base, reviewerToken, 27);
  assert(reviewerTools.some((tool) => tool.name === "list_dir"), "reviewer could not access a read-only daemon tool");
  assert(!reviewerTools.some((tool) => tool.name === "run_process"), "reviewer was shown a process-execution tool");

  const reviewerDeniedMessages = captureWsMessageTypes(candidateDaemon);
  const reviewerDenied = await currentMcpCall(base, reviewerToken, 271, "tools/call", {
    name: "run_process", arguments: { argv: ["true"] },
  });
  assert(!reviewerDeniedMessages.stop().includes("tool_call"), "reviewer process execution reached the daemon");
  assert(reviewerDenied.body.error?.code === -32602 && reviewerDenied.body.error?.message === "Unknown tool",
  "reviewer process execution was not rejected at the role-filtered protocol boundary");

  const operatorTools = await callToolsList(base, operatorToken, 273);
  assert(operatorTools.some((tool) => tool.name === "list_dir"), "operator lost ordinary workspace inspection");
  const forbiddenOperatorTools = ["exec_command", "run_local_command", "run_process", "start_process", "read_process", "write_process", "kill_process", "stage_job", "start_job"];
  assert(!operatorTools.some((tool) => forbiddenOperatorTools.includes(tool.name)),
    "operator tools/list exposed an arbitrary process or persistent execution tool");
  const operatorDeniedMessages = captureWsMessageTypes(candidateDaemon);
  const operatorDeniedCalls = [
    ["exec_command", { command: "true" }],
    ["run_local_command", { name: "fixed" }],
    ["run_process", { argv: ["true"] }],
    ["start_process", { argv: ["true"] }],
    ["read_process", { session_id: "unknown" }],
    ["write_process", { session_id: "unknown", data: "input" }],
    ["kill_process", { session_id: "unknown" }],
  ];
  for (let index = 0; index < operatorDeniedCalls.length; index += 1) {
    const [name, arguments_] = operatorDeniedCalls[index];
    const denied = await currentMcpCall(base, operatorToken, 274 + index, "tools/call", { name, arguments: arguments_ });
    assert(denied.body.error?.code === -32602 && denied.body.error?.message === "Unknown tool",
      `operator process boundary did not reject ${name} before dispatch`);
  }
  assert(!operatorDeniedMessages.stop().includes("tool_call"), "operator arbitrary process request reached the daemon");

  const reviewerRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reviewerReadPromise = currentMcpCall(base, reviewerToken, 272, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const reviewerRelay = await reviewerRelayPromise;
  assert(reviewerRelay.authorization?.role === "reviewer", "reviewer role was not forwarded to the daemon");
  assert(reviewerRelay.authorization?.account_id === reviewerAccount.body.account.account_id, "reviewer account id was not forwarded to the daemon");
  candidateDaemon.send(JSON.stringify({ type: "tool_result", id: reviewerRelay.id, ok: true, result: { entries: [] } }));
  const reviewerRead = await reviewerReadPromise;
  assert(reviewerRead.body.result?.isError === false, "reviewer read-only call failed");

  const relayedImageCallPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const remoteImageCall = currentMcpCall(base, ownerAccessToken, 76, "tools/call", {
    name: "view_image", arguments: { path: "pixel.png" },
  });
  const relayedImageCall = await relayedImageCallPromise;
  assert(relayedImageCall.tool === "view_image", "Worker relayed the wrong rich-content tool");
  const imageResultAck = waitForWsMessage(candidateDaemon, "tool_result_ack", 10_000, "rich result acknowledgement");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: relayedImageCall.id,
    ok: true,
    result: {
      $mcp: {
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        structuredContent: { path: "pixel.png", size: 8, mime_type: "image/png" },
      },
    },
  }));
  const acknowledgedImage = await imageResultAck;
  assert(acknowledgedImage.id === relayedImageCall.id, "Worker acknowledged the wrong daemon result");
  const remoteImage = await remoteImageCall;
  assert(remoteImage.response.status === 200, "rich image tools/call failed");
  assert(remoteImage.body.result?.content?.[0]?.type === "image", "Worker flattened native MCP image content");
  assert(remoteImage.body.result?.structuredContent?.path === "pixel.png", "Worker omitted rich structuredContent");
  assert(!JSON.stringify(remoteImage.body.result).includes("$mcp"), "Worker leaked the internal rich-result envelope");

  const timedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const durableAcceptanceCall = currentMcpCall(base, ownerAccessToken, 75, "tools/call", {
    name: "run_process", arguments: { argv: ["durable-step"], timeout_seconds: 1, idempotency_key: "worker-durable-acceptance" },
  });
  const timedRelay = await Promise.race([
    timedRelayPromise,
    durableAcceptanceCall.then((result) => {
      throw new Error(`durable acceptance HTTP response settled before daemon relay: ${result.response.status}`);
    }),
  ]);
  assert(timedRelay.tool === "run_process" && timedRelay.timeout_ms === 10_000
    && timedRelay.arguments?.timeout_seconds === 1
    && timedRelay.arguments?.idempotency_key === "worker-durable-acceptance",
  "Worker coupled the durable step lifetime back into the MCP acceptance deadline");
  const durableJobId = `job_${"d".repeat(24)}`;
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: timedRelay.id,
    ok: true,
    result: {
      accepted: true,
      execution_mode: "durable_job",
      job_id: durableJobId,
      execution_timeout_seconds: 1,
      idempotency_key_accepted: true,
      recovery: { tool: "read_job", job_id: durableJobId },
    },
  }));
  const durableAcceptanceResult = await durableAcceptanceCall;
  assert(durableAcceptanceResult.response.status === 200
    && durableAcceptanceResult.body.result?.isError === false
    && durableAcceptanceResult.body.result?.structuredContent?.execution_mode === "durable_job"
    && durableAcceptanceResult.body.result?.structuredContent?.job_id === durableJobId
    && /^mcp_jr_[A-Za-z0-9_-]{43}$/.test(String(durableAcceptanceResult.body.result?.structuredContent?.recovery_key || ""))
    && /^mcp_jc_[A-Za-z0-9_-]{43}$/.test(String(durableAcceptanceResult.body.result?.structuredContent?.control_key || "")),
  "durable process acceptance did not settle independently of the detached one-second step lifetime or return hosted recovery capabilities");

  const monitorClientCapabilities = {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  };
  const monitorAcceptanceRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const monitorAcceptanceCall = currentMcpCall(base, ownerAccessToken, 752, "tools/call", {
    name: "start_job",
    arguments: { idempotency_key: "worker-monitor-preissued-id", steps: [{ argv: ["durable-monitor-step"] }] },
  }, monitorClientCapabilities);
  const monitorAcceptanceRelay = await monitorAcceptanceRelayPromise;
  assert(monitorAcceptanceRelay.tool === "start_job"
    && monitorAcceptanceRelay.arguments?.idempotency_key === "worker-monitor-preissued-id",
  "MCP Apps monitor start_job fixture did not reach the daemon with its hosted idempotency contract");
  const monitorJobId = `job_${"m".repeat(24)}`;
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: monitorAcceptanceRelay.id,
    ok: true,
    result: {
      accepted: true,
      job_id: monitorJobId,
      status: "running",
      follow_up_read_required: true,
      same_response_followup_supported: true,
      host_turn_handoff_recommended: false,
      recovery: { tool: "read_job", job_id: monitorJobId },
    },
  }));
  const monitorAcceptanceResult = await monitorAcceptanceCall;
  const monitorAcceptanceStructured = monitorAcceptanceResult.body.result?.structuredContent;
  const monitorRecoveryKey = monitorAcceptanceStructured?.recovery_key;
  const monitorPreissuedId = String(monitorAcceptanceStructured?.ui_monitor_id || "");
  assert(monitorAcceptanceResult.response.status === 200
    && monitorAcceptanceResult.body.result?.isError === false
    && monitorAcceptanceStructured?.job_id === monitorJobId
    && monitorAcceptanceStructured?.ui_monitor_candidate === true
    && monitorAcceptanceStructured?.ui_monitor_render_tool === "render_job_monitor"
    && /^mcp_jr_[A-Za-z0-9_-]{43}$/.test(String(monitorRecoveryKey || ""))
    && /^mcp_jm_[a-f0-9]{32}$/.test(monitorPreissuedId),
  "active MCP Apps start_job did not expose the pre-issued monitor ID before render");

  const monitorRenderResult = await currentMcpCall(base, ownerAccessToken, 752, "tools/call", {
    name: "render_job_monitor",
    arguments: { job_id: monitorJobId, recovery_key: monitorRecoveryKey, ui_monitor_id: monitorPreissuedId },
  });
  const monitorRenderStructured = monitorRenderResult.body.result?.structuredContent;
  const monitorRenderText = String(monitorRenderResult.body.result?.content?.[0]?.text || "");
  const monitorRenderId = String(monitorRenderStructured?.ui_monitor_id || "");
  assert(monitorRenderResult.response.status === 200
    && monitorRenderResult.body.result?.isError === false
    && monitorRenderStructured?.job_id === monitorJobId
    && monitorRenderId === monitorPreissuedId
    && monitorRenderStructured?.ui_monitor_claim_required === true
    && monitorRenderStructured?.follow_up_read_required === true
    && !("recovery_key" in monitorRenderStructured)
    && !("control_key" in monitorRenderStructured)
    && monitorRenderText === "",
  "render_job_monitor did not activate the exact start_job monitor ID without adding host status prose");

  const monitorPreClaimRead = await currentMcpCall(base, ownerAccessToken, 753, "tools/call", {
    name: "read_job_monitor",
    arguments: { job_id: monitorJobId, recovery_key: monitorRecoveryKey, ui_monitor_id: monitorPreissuedId },
  });
  assert(monitorPreClaimRead.response.status === 200
    && monitorPreClaimRead.body.result?.isError === true
    && monitorPreClaimRead.body.result?.structuredContent?.error?.code === "invalid_request",
  "app-only monitor read was dispatched before the mounted View claimed continuation");
  const monitorClaimResult = await currentMcpCall(base, ownerAccessToken, 754, "tools/call", {
    name: "claim_job_monitor",
    arguments: { job_id: monitorJobId, recovery_key: monitorRecoveryKey, ui_monitor_id: monitorPreissuedId },
  });
  assert(monitorClaimResult.response.status === 200
    && monitorClaimResult.body.result?.isError === false
    && monitorClaimResult.body.result?.structuredContent?.claimed === true,
  "mounted monitor View could not claim the activated start_job monitor ID");

  const monitorReadRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const monitorReadCall = currentMcpCall(base, ownerAccessToken, 755, "tools/call", {
    name: "read_job_monitor",
    arguments: { job_id: monitorJobId, recovery_key: monitorRecoveryKey, ui_monitor_id: monitorPreissuedId },
  });
  const monitorReadRelay = await monitorReadRelayPromise;
  assert(monitorReadRelay.tool === "read_job"
    && monitorReadRelay.arguments?.job_id === monitorJobId
    && monitorReadRelay.arguments?.wait_ms === 40_000
    && monitorReadRelay.arguments?.recovery_key === undefined
    && monitorReadRelay.arguments?.ui_monitor_id === undefined,
  "app-only monitor read did not reduce to one fixed capability-checked daemon read_job call");
  candidateDaemon.send(JSON.stringify({
    type: "tool_result",
    id: monitorReadRelay.id,
    ok: true,
    result: {
      job_id: monitorJobId, status: "running", current_phase: "steps", current_step: 0,
      recovery_key: "monitor-secret-recovery", control_key: "monitor-secret-control",
      private_path: "/private/monitor-secret-path",
      result: { steps: [{ stdout: "monitor-secret-output", stderr: "monitor-secret-error", command: "monitor-secret-command" }] },
    },
  }));
  const monitorReadResult = await monitorReadCall;
  const monitorReadStructured = monitorReadResult.body.result?.structuredContent;
  const monitorReadText = JSON.stringify(monitorReadStructured);
  assert(monitorReadResult.response.status === 200
    && monitorReadResult.body.result?.isError === false
    && monitorReadStructured?.job_id === monitorJobId
    && monitorReadStructured?.status === "running"
    && monitorReadStructured?.current_phase === "steps"
    && monitorReadStructured?.current_step === 0
    && !("result" in monitorReadStructured) && !("recovery_key" in monitorReadStructured)
    && !("control_key" in monitorReadStructured) && !("private_path" in monitorReadStructured)
    && !monitorReadText.includes("monitor-secret"),
  "app-only monitor read did not return a privacy-bounded durable job status projection");

  const ambiguousAcceptanceKey = "worker-ambiguous-durable-acceptance";
  const ambiguousRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const ambiguousAcceptanceCall = currentMcpCall(base, ownerAccessToken, 751, "tools/call", {
    name: "run_process",
    arguments: { argv: ["durable-step-with-lost-acceptance"], timeout_seconds: 1, idempotency_key: ambiguousAcceptanceKey },
  });
  const ambiguousRelay = await ambiguousRelayPromise;
  assert(ambiguousRelay.tool === "run_process"
    && ambiguousRelay.arguments?.idempotency_key === ambiguousAcceptanceKey
    && ambiguousRelay.timeout_ms === 10_000,
  "ambiguous durable acceptance fixture lost its caller-held recovery key before daemon dispatch");
  const ambiguousCancel = await waitForWsMessage(candidateDaemon, "cancel_call", 20_000);
  assert(ambiguousCancel.id === ambiguousRelay.id,
    "durable acceptance timeout cancellation targeted the wrong daemon call");
  const ambiguousAcceptanceResult = await ambiguousAcceptanceCall;
  const ambiguousError = ambiguousAcceptanceResult.body.result?.structuredContent?.error;
  assert(ambiguousAcceptanceResult.response.status === 200
    && ambiguousAcceptanceResult.body.result?.isError === true
    && ambiguousError?.code === "timeout"
    && ambiguousError?.details?.side_effects_started === true
    && ambiguousError?.details?.recovery?.credential === "idempotency_key"
    && ambiguousError?.details?.recovery?.credential_source === "original_request_arguments"
    && ambiguousError?.details?.recovery?.idempotency_key === undefined
    && ambiguousError?.details?.recovery?.action === "retry_same_tool_arguments_with_same_idempotency_key",
  "lost durable acceptance response did not return a non-echoing idempotent recovery instruction");

  const demoteLastOwner = await stableFetch(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: ownerAccount.body.account.account_id, role: "reviewer",
  }));
  assert(demoteLastOwner.status === 409, "last active owner could be demoted");

  const reviewerRevokedSubscriptionResponse = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(reviewerToken, "subscriptions/listen"),
    body: JSON.stringify(currentMcpRequest(2729, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    })),
  });
  const reviewerRevokedSubscriptionReader = reviewerRevokedSubscriptionResponse.body.getReader();
  const reviewerRevokedSubscriptionMessages = await readSseJsonMessages(reviewerRevokedSubscriptionReader, 2);
  assert(reviewerRevokedSubscriptionResponse.status === 200
      && reviewerRevokedSubscriptionMessages[1]?.method === "notifications/tools/list_changed",
  "reviewer authority-revocation fixture did not establish a live subscription");
  const reviewerRevokedSubscriptionPending = reviewerRevokedSubscriptionReader.read();
  const reviewerRevokedRelayPromise = waitForWsMessage(candidateDaemon, "tool_call");
  const reviewerRevokedCall = currentMcpCall(base, reviewerToken, 2730, "tools/call", {
    name: "list_dir", arguments: { path: "." },
  });
  const reviewerRevokedRelay = await reviewerRevokedRelayPromise;
  const firstAuthorityRevoke = waitForWsMessage(candidateDaemon, "authority_revoke", 10_000, "reviewer authority revocation");
  const reviewerRoleChange = await fetchJson(`${base}/admin/accounts`, adminRequest("PATCH", "/admin/accounts", {
    account_id: reviewerAccount.body.account.account_id, role: "editor",
  }));
  assert(reviewerRoleChange.response.status === 200, "reviewer role change failed");
  const initialRevoke = await firstAuthorityRevoke;
  assert(initialRevoke.account_id === reviewerRelay.authorization.account_id
    && initialRevoke.account_version === reviewerRevokedRelay.authorization.account_version
    && initialRevoke.client_id === undefined && initialRevoke.family_id === undefined,
  "reviewer role change did not deliver a broad revocation for the exact previous account version");
  const reviewerRevokedResult = await reviewerRevokedCall;
  assert(reviewerRevokedResult.body.result?.isError === true
    && reviewerRevokedResult.body.result?.structuredContent?.error?.code === "authorization_denied",
  "reviewer in-flight call survived its account-version revocation");
  const revokedSubscriptionSettlement = await Promise.race([
    reviewerRevokedSubscriptionPending.then((result) => ({ settled: true, done: result.done === true }), () => ({ settled: true, done: true })),
    sleep(1_000).then(() => ({ settled: false, done: false })),
  ]);
  assert(revokedSubscriptionSettlement.settled && revokedSubscriptionSettlement.done,
    "reviewer account-version revocation left its authenticated subscription stream alive");

  const replacedForRevocation = candidateDaemon;
  const replacedForRevocationClosed = waitForWsClose(replacedForRevocation);
  candidateDaemon = await connectDaemon(base);
  daemonSockets.push(candidateDaemon);
  const revocationReplayProbe = await beginDaemonHello(candidateDaemon, candidateTools, candidatePolicy, candidateInstanceId);
  const revocationReplay = await completeDaemonProbeWithRevocations(candidateDaemon, revocationReplayProbe, 1);
  assert(revocationReplay.resume.ids.length === 0, "revoked pending call was rebound during daemon handover");
  const replayedRevoke = revocationReplay.revocations[0];
  assert(replayedRevoke.revocation_id === initialRevoke.revocation_id
    && replayedRevoke.account_id === initialRevoke.account_id
    && replayedRevoke.account_version === initialRevoke.account_version,
  "unacknowledged authority revocation was not durably replayed before daemon readiness");
  assert((await replacedForRevocationClosed).code === 1012, "authority-revocation handover did not replace the previous daemon cleanly");
  candidateDaemon.send(JSON.stringify({ type: "authority_revoke_ack", revocation_id: replayedRevoke.revocation_id }));
  const revocationBarrier = waitForWsMessage(candidateDaemon, "pong", 10_000, "authority revocation acknowledgement barrier");
  candidateDaemon.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  await revocationBarrier;

  const revokedReviewer = await stableFetch(`${base}/mcp`, {
    method: "POST",
    headers: currentMcpHeaders(reviewerToken, "tools/list"),
    body: JSON.stringify(currentMcpRequest(273, "tools/list", {})),
  });
  assert(revokedReviewer.status === 401, "role change did not revoke the changed account token");
  const postAckMessages = captureWsMessageTypes(candidateDaemon);
  const revokedReviewerRefresh = await fetchJson(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: reviewerRefreshToken,
      client_id: reviewerRegistration.client_id,
      resource: `${base}/mcp`,
    }),
  });
  assert(revokedReviewerRefresh.response.status === 400 && revokedReviewerRefresh.body.error === "invalid_grant", "role change did not revoke the changed account refresh token");
  assert(!postAckMessages.stop().includes("authority_revoke"), "acknowledged authority revocation remained in the durable replay queue");
  const ownerAfterReviewerChange = await callServerInfo(base, ownerAccessToken, 274);
  assert(ownerAfterReviewerChange.account?.role === "owner", "another account change invalidated the owner token");
  assert(ownerAfterReviewerChange.authorization.execution_model.owner_ambient_authority === "daemon_os_user", "owner server_info omitted daemon OS-user ambient authority");
  assert(ownerAfterReviewerChange.authority_summary?.includes("daemon OS user"), "owner authority summary hid ambient authority");

  for (let index = 0; index < 5; index += 1) {
    const extraRegistration = await stableFetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `Quota Client ${index}`, redirect_uris: [redirectUri] }),
    });
    assert(extraRegistration.status === 201, `pending-registration quota rejected client ${index + 1} too early`);
  }
  const registrationOverflow = await stableFetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Quota Overflow", redirect_uris: [redirectUri] }),
  });
  assert(registrationOverflow.status === 429, "per-source pending-registration quota was not enforced");

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const failedLogin = await stableFetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: `invalid_attempt_${String(attempt).padStart(2, "0")}${"D".repeat(41)}` }),
      redirect: "manual",
    });
    const expectedStatus = attempt === 10 ? 429 : 401;
    assert(failedLogin.status === expectedStatus, `password throttling attempt ${attempt} returned ${failedLogin.status}`);
  }
  const blockedLogin = await stableFetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorization, account_name: "owner", account_password: OWNER_PASSWORD }),
    redirect: "manual",
  });
  assert(blockedLogin.status === 429, "blocked source could immediately retry with the correct password");

  const fullDaemon = await connectDaemon(base);
  daemonSockets.push(fullDaemon);
  await sendDaemonHello(fullDaemon, ["project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"], {
    profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell",
    unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true,
  });
  const editorStatus = await callServerInfo(base, editorToken, 275);
  assert(editorStatus.account?.account_id === editorAccount.body.account.account_id && editorStatus.account?.role === "editor", "server_info reported the wrong authenticated editor account");
  assert(editorStatus.daemon?.policy?.profile === "full", "full daemon ceiling was not preserved");
  assert(Array.isArray(editorStatus.daemon?.tools) && editorStatus.daemon.tools.length === 0
    && editorStatus.daemon?.tools_hidden_by_authority === true
    && editorStatus.daemon?.tool_count === 6,
  "non-owner server_info leaked daemon-only tool names instead of retaining only the ceiling count");
  assert(editorStatus.daemon?.policy_scope === "daemon_capability_ceiling_not_account_authority", "daemon policy scope remained ambiguous");
  assert(editorStatus.tool_delivery?.full_profile_scope === "daemon-capability-ceiling-before-account-filtering", "full-profile delivery scope remained ambiguous");
  assert(editorStatus.authorization?.account_policy?.profile === "edit", "editor account policy was not reported");
  assert(editorStatus.authorization?.effective_policy?.profile === "edit", "editor effective policy was incorrectly reported as full");
  assert(editorStatus.authorization?.effective_profile_is_full === false, "editor was marked as full authority");
  assert(editorStatus.authorization?.effective_tools?.includes("write_file"), "editor effective tools omitted deterministic mutation");
  assert(!editorStatus.authorization?.effective_tools?.includes("exec_command"), "editor effective tools exposed shell execution");
  assert(!editorStatus.authorization?.effective_tools?.includes("browser_action"), "editor effective tools exposed browser authority");
  assert(JSON.stringify(editorStatus.tools) === JSON.stringify(editorStatus.authorization.effective_tools), "top-level tools diverged from authoritative effective tools");
  assert(editorStatus.authority_summary?.includes("not this account's permission"), "authority summary did not reject the daemon-policy misinterpretation");
  assert(editorStatus.authority_summary?.includes("without a per-operation prompt"), "authority summary hid automatic execution semantics");
  assert(editorStatus.authorization.execution_model.within_effective_authority === "automatic_without_per_operation_prompt", "server_info omitted the automatic execution model");
  assert(editorStatus.authorization.execution_model.owner_ambient_authority === "not_owner", "delegated account was mislabeled as owner ambient authority");

  const editorOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const editorOverviewPromise = toolCallRequest(base, editorToken, 276, "project_overview", {});
  const editorOverviewRelay = await editorOverviewRelayPromise;
  assert(editorOverviewRelay.authorization?.role === "editor", "project_overview did not relay the editor role");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: editorOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "",
      policy: { profile: "custom", origin: "effective", revision: 5, allowWrite: true, allowExec: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      privateDaemonField: "/synthetic/private/daemon-state",
      topLevel: [{ name: "src", path: "/synthetic/workspace/src", type: "directory", size: 4096, private_metadata: "daemon-private" }],
    },
  }));
  const editorOverview = (await editorOverviewPromise).body.result?.structuredContent;
  assert(editorOverview?.policy?.profile === "edit", "remote project_overview exposed the daemon full policy as editor authority");
  assert(editorOverview?.daemonPolicy?.profile === "full", "remote project_overview lost the daemon capability ceiling");
  assert(editorOverview?.tools?.includes("write_file") && !editorOverview?.tools?.includes("exec_command") && !editorOverview?.tools?.includes("browser_action"), "remote project_overview did not expose editor-effective tools");
  assert(Array.isArray(editorOverview?.daemonTools) && editorOverview.daemonTools.length === 0
    && editorOverview?.daemonToolCount === 7 && editorOverview?.daemonToolsHiddenByAuthority === true,
  "remote project_overview leaked daemon-only tool names to a non-owner account");
  assert(editorOverview?.workspace === "." && editorOverview?.workspaceName === "workspace" && editorOverview?.gitRoot === ""
    && editorOverview?.capabilityRouting?.activity_hidden_by_authority === true
    && !("privateDaemonField" in editorOverview)
    && editorOverview?.topLevel?.[0]?.name === "src" && editorOverview?.topLevel?.[0]?.size === 4096
    && !("path" in editorOverview.topLevel[0]) && !("private_metadata" in editorOverview.topLevel[0]),
  "remote project_overview failed to enforce fail-closed non-owner path/activity/unknown-field privacy at the Worker boundary");
  assert(editorOverview?.policyScope === "authenticated_account_effective_authority", "remote project_overview policy scope remained ambiguous");

  const compactOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const compactOverviewPromise = toolCallRequest(base, editorToken, 2761, "project_overview", { detail: "summary" });
  const compactOverviewRelay = await compactOverviewRelayPromise;
  assert(compactOverviewRelay.authorization?.role === "editor"
    && compactOverviewRelay.arguments && Object.keys(compactOverviewRelay.arguments).length === 0,
  "remote compact project_overview failed to use the backward-compatible default/full daemon request");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: compactOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "/synthetic/workspace",
      policy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      privateDaemonField: "/synthetic/private/summary-state",
      capabilityRouting: {
        bootstrap_observed: true, bootstrap_count: 8, task_resolution_observed: true, task_resolution_count: 3,
        last_task_resolution: {
          observed_at: "2026-08-08T00:00:00.000Z", task_fingerprint: "private-fingerprint", refresh_fingerprint: "private-refresh",
          selected_skill: "review", matched_skills: 2, matched_commands: 3, matched_applications: 4,
          recommended_tools: ["read_file", "git_status"], primary_route: "files", routing_ambiguity: "low", routing_score_gap: 4,
        },
        enforcement_boundary: "long cold-path explanation",
      },
      topLevel: [
        { name: "src", path: "/synthetic/workspace/src", type: "directory", size: 4096, private_metadata: "summary-private" },
        { name: "README.md", path: "/synthetic/workspace/README.md", type: "file", size: 1234 },
      ],
      topLevelTotal: 2, topLevelTruncated: false,
    },
  }));
  const compactOverview = (await compactOverviewPromise).body.result?.structuredContent;
  const compactOverviewJson = JSON.stringify(compactOverview);
  assert(compactOverview?.detail === "summary"
    && compactOverview?.policy?.profile === "edit"
    && compactOverview?.effectiveToolCount === 5
    && compactOverview?.daemonToolCount === 7
    && compactOverview?.authorization?.account?.role === "editor"
    && !("account_id" in compactOverview.authorization.account)
    && compactOverview?.authorization?.effective_tool_count === 5
    && compactOverview?.topLevel?.[0]?.name === "src"
    && !("path" in compactOverview.topLevel[0]) && !("size" in compactOverview.topLevel[0])
    && !("private_metadata" in compactOverview.topLevel[0]) && !("privateDaemonField" in compactOverview)
    && compactOverview?.capabilityRouting?.activity_hidden_by_authority === true
    && compactOverview?.daemonToolsHiddenByAuthority === true
    && !("last_task_resolution" in compactOverview.capabilityRouting)
    && !("tools" in compactOverview) && !("daemonTools" in compactOverview),
  "remote compact project_overview leaked cold-path identity/tool/path/activity fields or lost effective authority");
  assert(compactOverviewJson.length <= 2600,
    `remote compact project_overview exceeded its hot-path output budget: ${compactOverviewJson.length} chars`);

  const explicitFullOverviewRelayPromise = waitForWsMessage(fullDaemon, "tool_call");
  const explicitFullOverviewPromise = toolCallRequest(base, editorToken, 2762, "project_overview", { detail: "full" });
  const explicitFullOverviewRelay = await explicitFullOverviewRelayPromise;
  assert(explicitFullOverviewRelay.arguments && Object.keys(explicitFullOverviewRelay.arguments).length === 0,
    "explicit full project_overview was not normalized for an older default-full daemon");
  fullDaemon.send(JSON.stringify({
    type: "tool_result", id: explicitFullOverviewRelay.id, ok: true,
    result: {
      workspace: "/synthetic/workspace", workspaceName: "workspace", gitRoot: "",
      policy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      tools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      daemonPolicy: { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
      daemonTools: ["server_info", "project_overview", "list_dir", "read_file", "write_file", "exec_command", "browser_action"],
      topLevel: [],
    },
  }));
  const explicitFullOverview = (await explicitFullOverviewPromise).body.result?.structuredContent;
  assert(Array.isArray(explicitFullOverview?.tools)
    && explicitFullOverview?.authorization?.account?.account_id === editorAccount.body.account.account_id
    && !("detail" in explicitFullOverview),
  "explicit full project_overview lost backward-compatible full authority fields");

  const duplicateHelloDaemon = await connectDaemon(base);
  daemonSockets.push(duplicateHelloDaemon);
  await sendDaemonHello(duplicateHelloDaemon, ["list_dir"]);
  const duplicateHelloNotice = waitForWsMessage(duplicateHelloDaemon, "error");
  const duplicateHelloClosed = waitForWsClose(duplicateHelloDaemon);
  duplicateHelloDaemon.send(JSON.stringify({ type: "hello", tools: ["list_dir"], policy: {} }));
  assert((await duplicateHelloNotice).error === "duplicate_hello", "duplicate daemon hello returned the wrong protocol error");
  assert((await duplicateHelloClosed).code === 1002, "duplicate daemon hello did not close with protocol-error status");

  const unknownMessageDaemon = await connectDaemon(base);
  daemonSockets.push(unknownMessageDaemon);
  await sendDaemonHello(unknownMessageDaemon, ["list_dir"]);
  const unknownMessageNotice = waitForWsMessage(unknownMessageDaemon, "error");
  const unknownMessageClosed = waitForWsClose(unknownMessageDaemon);
  unknownMessageDaemon.send(JSON.stringify({ type: "future_daemon_message" }));
  assert((await unknownMessageNotice).error === "unknown_message_type", "unknown daemon message returned the wrong protocol error");
  assert((await unknownMessageClosed).code === 1002, "unknown daemon message did not close with protocol-error status");

  assert(!logs.includes("Uncaught TypeError"), "wrangler reported an uncaught runtime TypeError");
  await Promise.resolve();
  assert(activeHttpRequests.size === 0,
    `worker integration left ${activeHttpRequests.size} HTTP request(s) unsettled`);
  console.log("worker OAuth/MCP integration test ok");
}
