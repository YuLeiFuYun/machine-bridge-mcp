import * as common from "./common.mjs";
const {
  nodeAssert, handleOuterWorkerFetch, DaemonHttpChannel,
  queueDaemonHttpRevocations, PendingCallRegistry,
  MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT, pendingCapacityProjection, DaemonSocketRegistry,
  DaemonRegistry, cancelReadyDaemonAuthority, notifyReadyDaemon,
  readyDaemonWaiterSnapshot, waitForReadyDaemon, immediateReadyDaemonForDispatch,
  readyDaemonForDispatch, sanitizeDaemonRelayDiagnostics, respondWithoutDurableObject,
  admitGlobalStatefulRequest, admitStatefulRequest, durableObjectQuotaResponse,
  isDurableObjectQuotaError, outerWorkerErrorClass, statefulRateLimitKey, statefulRouteClass,
  workerGatewayErrorResponse,
  relayContract, WorkerToolError, WorkerObservability, ManagedJobMonitorClaimStore, applyCors, corsPreflight, SYNTHETIC_ACCOUNT_ID,
  TestWebSocket, testDurableStorage, expectReject, assert
} = common;

async function testDaemonReadyWaiters() {
  let readySockets = [];
  const registry = { readySockets: () => readySockets };
  const socket = { readyState: 1 };
  const waiting = waitForReadyDaemon(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1 && await waiting === socket,
    "brief daemon reconnect did not wake a waiting new call");
  assert(await waitForReadyDaemon(registry, { graceMs: 1 }) === socket,
    "ready daemon call admission unnecessarily waited");
  const preAborted = new AbortController();
  preAborted.abort();
  for (const admit of [waitForReadyDaemon, readyDaemonForDispatch]) {
    await nodeAssert.rejects(admit(registry, { signal: preAborted.signal }), error => error.code === "cancelled",
      "already-ready daemon ignored pre-dispatch cancellation");
    assert(readyDaemonWaiterSnapshot(registry).active === 0, "pre-aborted admission retained a readiness waiter");
  }
  const synchronousImmediate = immediateReadyDaemonForDispatch(registry);
  assert(synchronousImmediate?.socket === socket && synchronousImmediate.recoveryDelayMs === 0,
    "ready daemon dispatch lost its synchronous no-yield admission path");
  let immediateClockReads = 0;
  const immediateDispatch = await readyDaemonForDispatch(registry, { graceMs: 1 }, () => {
    immediateClockReads += 1;
    return 100;
  });
  assert(immediateDispatch.socket === socket && immediateDispatch.recoveryDelayMs === 0 && immediateClockReads === 0,
    "already-ready daemon dispatch consumed recovery budget or sampled the recovery clock");
  readySockets = [];
  let recoveryClock = 100;
  const delayedDispatch = readyDaemonForDispatch(registry, { graceMs: 100 }, () => {
    const value = recoveryClock;
    recoveryClock += 50;
    return value;
  });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1, "recovered daemon dispatch did not wake its waiter");
  const recoveredDispatch = await delayedDispatch;
  assert(recoveredDispatch.socket === socket && recoveredDispatch.recoveryDelayMs === 50,
    "daemon recovery wait did not report only the actual recovery interval");
  readySockets = [];
  const defaultClockDispatch = readyDaemonForDispatch(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1, "default recovery clock case did not wake its waiter");
  const defaultClockRecovered = await defaultClockDispatch;
  assert(defaultClockRecovered.socket === socket && defaultClockRecovered.recoveryDelayMs >= 0,
    "default monotonic recovery clock did not produce a bounded interval");
  readySockets = [];
  const handoverFirst = waitForReadyDaemon(registry, { graceMs: 100 });
  await Promise.resolve();
  readySockets = [socket];
  assert(immediateReadyDaemonForDispatch(registry) === null,
    "new call bypassed retained pre-dispatch waiters while daemon handover was not yet released");
  let handoverSecondSettled = false;
  const handoverSecond = waitForReadyDaemon(registry, { graceMs: 100 }).then((value) => {
    handoverSecondSettled = true;
    return value;
  });
  await Promise.resolve();
  assert(handoverSecondSettled === false && readyDaemonWaiterSnapshot(registry).active === 2,
    "ready socket let fresh traffic leapfrog reconnect waiters before final handover notification");
  assert(notifyReadyDaemon(registry) === 2
    && (await handoverFirst) === socket && (await handoverSecond) === socket,
  "final daemon handover did not release the complete capacity-reserved waiter batch");
  readySockets = [];
  const unreleasedReady = waitForReadyDaemon(registry, { graceMs: 5 });
  await Promise.resolve();
  readySockets = [socket];
  let unreleasedReadyError = null;
  try { await unreleasedReady; } catch (error) { unreleasedReadyError = error; }
  assert(unreleasedReadyError?.code === "unavailable",
    "ready-daemon waiter timeout bypassed the missing final handover notification");
  readySockets = [];
  let timeoutError = null;
  try { await waitForReadyDaemon(registry, { graceMs: 5 }); } catch (error) { timeoutError = error; }
  assert(timeoutError?.code === "unavailable", "daemon reconnect admission timeout did not remain retryable-unavailable");
  const controller = new AbortController();
  const aborted = waitForReadyDaemon(registry, { graceMs: 100, signal: controller.signal });
  controller.abort();
  let abortError = null;
  try { await aborted; } catch (error) { abortError = error; }
  assert(abortError?.code === "cancelled", "daemon reconnect admission ignored client cancellation");
  const accountA = "account-ready-read-a";
  const accountB = "account-ready-read-b";
  const waiterAuthority = (accountId, familyId = `family-${accountId}`) => ({
    accountId, accountVersion: 4, clientId: `client-${accountId}`, familyId,
  });
  const revokedWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", authority: waiterAuthority(accountA),
    pending: { active: 0, by_tool: {} },
  });
  assert(cancelReadyDaemonAuthority(registry, {
    accountId: accountA, accountVersion: 4,
    clientId: `client-${accountA}`, familyId: "different-family",
  }) === 0, "daemon readiness authority revocation matched a different refresh family");
  assert(cancelReadyDaemonAuthority(registry, waiterAuthority(accountA)) === 1,
    "daemon readiness authority revocation did not cancel a matching pre-dispatch waiter");
  let revokedWaiterError = null;
  try { await revokedWaiter; } catch (error) { revokedWaiterError = error; }
  assert(revokedWaiterError?.code === "authorization_denied" && readyDaemonWaiterSnapshot(registry).active === 0,
    "revoked pre-dispatch daemon waiter retained stale authority or capacity");
  const handoverRevoked = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", authority: waiterAuthority(accountA),
    pending: { active: 0, by_tool: {} },
  });
  await Promise.resolve();
  readySockets = [socket];
  assert(immediateReadyDaemonForDispatch(registry) === null
    && cancelReadyDaemonAuthority(registry, waiterAuthority(accountA)) === 1,
  "visible ready socket bypassed authority revocation before final handover release");
  let handoverRevokedError = null;
  try { await handoverRevoked; } catch (error) { handoverRevokedError = error; }
  assert(handoverRevokedError?.code === "authorization_denied" && readyDaemonWaiterSnapshot(registry).active === 0,
    "handover-phase ready waiter escaped revocation before pending ownership transfer");
  readySockets = [];
  const readJobWaiters = [];
  for (let index = 0; index < MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT; index += 1) {
    readJobWaiters.push(waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
    }));
  }
  let accountReadLimitError = null;
  try {
    await waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
    });
  } catch (error) { accountReadLimitError = error; }
  assert(accountReadLimitError?.code === "limit_exceeded",
    "daemon reconnect waiters let one account monopolize managed-job long-poll recovery capacity");
  const otherAccountReadWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountB),
    activeReadJobCallsForAccount: 0, pending: { active: 0, by_tool: {} },
  });
  assert(readyDaemonWaiterSnapshot(registry).by_tool.read_job === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT + 1,
    "daemon reconnect managed-job read ceiling became a global account-independent ceiling");
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT + 1,
    "daemon reconnect did not release the account-bounded read_job waiter batch");
  assert((await Promise.all([...readJobWaiters, otherAccountReadWaiter])).every((value) => value === socket),
    "account-bounded daemon reconnect waiters did not settle on the recovered daemon");
  readySockets = [];
  const activeReadWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
    activeReadJobCallsForAccount: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1,
    pending: { active: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1, by_tool: { read_job: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1 } },
  });
  let combinedReadLimitError = null;
  try {
    await waitForReadyDaemon(registry, {
      graceMs: 1000, tool: "read_job", authority: waiterAuthority(accountA),
      activeReadJobCallsForAccount: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1,
      pending: { active: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1, by_tool: { read_job: MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT - 1 } },
    });
  } catch (error) { combinedReadLimitError = error; }
  assert(combinedReadLimitError?.code === "limit_exceeded",
    "daemon reconnect read_job ceiling ignored already-active long polls for the same account");
  readySockets = [socket];
  assert(notifyReadyDaemon(registry) === 1 && await activeReadWaiter === socket,
    "daemon reconnect read_job waiter did not release after combining active and waiting account usage");
  readySockets = [];
  const detachedPending = { active: 29, by_tool: { read_file: 29 } };
  const ordinaryWaiter = waitForReadyDaemon(registry, {
    graceMs: 1000, tool: "read_file", pending: detachedPending,
  });
  await Promise.resolve();
  let ordinaryLimitError = null;
  try {
    await waitForReadyDaemon(registry, { graceMs: 1000, tool: "read_file", pending: detachedPending });
  } catch (error) { ordinaryLimitError = error; }
  assert(ordinaryLimitError?.code === "limit_exceeded",
    "daemon reconnect ordinary waiters consumed reserved control-plane capacity");
  const controlWaiters = [
    waitForReadyDaemon(registry, { graceMs: 1000, tool: "diagnose_runtime", pending: detachedPending }),
    waitForReadyDaemon(registry, { graceMs: 1000, tool: "list_roots", pending: detachedPending }),
  ];
  await Promise.resolve();
  let totalLimitError = null;
  try {
    await waitForReadyDaemon(registry, { graceMs: 1000, tool: "diagnose_runtime", pending: detachedPending });
  } catch (error) { totalLimitError = error; }
  assert(totalLimitError?.code === "limit_exceeded", "daemon reconnect waiters exceeded the shared 30+2 call ceiling");
  const waiterSnapshot = readyDaemonWaiterSnapshot(registry);
  assert(waiterSnapshot.active === 3
    && waiterSnapshot.by_tool.read_file === 1
    && waiterSnapshot.by_tool.diagnose_runtime === 1
    && waiterSnapshot.by_tool.list_roots === 1,
  "daemon reconnect waiter diagnostics lost privacy-safe per-tool capacity counts");
  const capacityProjection = pendingCapacityProjection({
    active: 29, detached: 29, request_keys: 0, maximum: 32, ordinary_capacity: 30, reserved_capacity: 2,
    active_reserved: 0, active_ordinary: 29, oldest_ms: 123, by_tool: { read_file: 29 },
  }, waiterSnapshot);
  assert(capacityProjection.active === 29
    && capacityProjection.pre_dispatch_waiters === 3
    && capacityProjection.capacity_active === 32
    && capacityProjection.capacity_active_ordinary === 30
    && capacityProjection.capacity_active_reserved === 2,
  "Worker capacity diagnostics omitted pre-dispatch daemon waiters or reserved-control usage");
  readySockets = [socket];
  const boundedWaiters = [ordinaryWaiter, ...controlWaiters];
  assert(notifyReadyDaemon(registry) === 3 && (await Promise.all(boundedWaiters)).every((value) => value === socket),
    "daemon reconnect did not release the shared-capacity waiter batch exactly once");
  assert(readyDaemonWaiterSnapshot(registry).active === 0, "ready notification retained stale waiter diagnostics");
}

async function testAbortSignalCleanup() {
  const registry = new PendingCallRegistry(1);
  const controller = new AbortController();
  let cancelledId = "";
  const cancelled = registry.register({
    id: "request-abort", tool: "list_dir", socket: {}, clientRequestKey: "abort-key", timeoutMs: 10_000,
    signal: controller.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: (record) => {
      cancelledId = record.id;
      return new WorkerToolError("cancelled", "client stopped waiting");
    },
  });
  assert(registry.snapshot().active === 1 && registry.hasRequestKey("abort-key"), "abortable call was not registered");
  controller.abort();
  await expectReject(cancelled, "client stopped waiting");
  assert(cancelledId === "request-abort", "abort callback received the wrong pending call");
  assert(registry.snapshot().active === 0 && registry.snapshot().request_keys === 0, "request abort leaked pending indexes");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const rejectedImmediately = registry.register({
    id: "already-aborted", tool: "list_dir", socket: {}, timeoutMs: 10_000,
    signal: alreadyAborted.signal,
    onTimeout: () => new Error("timeout"),
    onAbort: () => new WorkerToolError("cancelled", "already cancelled"),
  });
  await expectReject(rejectedImmediately, "already cancelled");
  assert(registry.snapshot().active === 0, "already-aborted request entered the pending registry");
}

async function testDaemonSocketIsolation() {
  const malformedRole = new TestWebSocket();
  malformedRole.serializeAttachment({ role: ["daemon"], connectedAt: new Date().toISOString() });
  const malformedRoleRegistry = new DaemonSocketRegistry({ getWebSockets: () => [malformedRole] });
  assert(malformedRoleRegistry.attachment(malformedRole) === undefined
    && malformedRoleRegistry.readyChannels().length === 0,
  "non-string daemon socket role crossed the persisted authority boundary through string coercion");

  const candidate = new TestWebSocket();
  candidate.serializeAttachment({ role: "candidate", connectedAt: new Date().toISOString() });
  const registry = new DaemonSocketRegistry({ getWebSockets: () => [candidate] });
  const sockets = registry.nonReadySockets();
  assert(sockets.length === 1 && sockets[0] === candidate, "daemon candidate lookup lost the authenticated socket");
  const expired = registry.expire(candidate);
  assert(expired?.role === "candidate" && registry.attachment(candidate)?.role === "expired",
    "daemon socket expiry did not return and preserve the original attachment identity");
  assert(registry.expire(candidate) === undefined, "daemon socket expiry was not idempotent");

  const probing = new TestWebSocket();
  probing.serializeAttachment({
    role: "probing", connectedAt: "2026-08-04T11:36:29.000Z", lastSeenAt: "2026-08-04T11:36:29.000Z",
    probeId: "probe_ready_projection", instanceId: "daemon_ready_projection_123456",
    connectionId: `connection_${"R".repeat(43)}`,
    policy: { profile: "full", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true },
    tools: ["list_roots"],
    relayDiagnostics: {
      schema_version: 1, network_route: "system-network-stack", outage_count: 1, outage_active: true,
      outage_started_at: "2026-08-04T11:36:20.000Z", outage_duration_ms: 9000, outage_attempts: 2,
      last_close_category: "relay_transport_error", last_close_code: 1006,
      last_transport_error_class: "network_error", last_disconnected_at: "2026-08-04T11:36:20.000Z",
      previous_ready_duration_ms: 123456,
    },
  });
  const readyRegistry = new DaemonSocketRegistry({ getWebSockets: () => [probing] });
  const promoted = readyRegistry.promote(probing, "2026-08-04T11:36:30.000Z");
  assert(promoted?.role === "daemon"
    && promoted.relayDiagnostics?.outage_active === false
    && promoted.relayDiagnostics.outage_duration_ms === 10_000,
  "ready socket promotion retained a reconnect-in-progress or pre-readiness diagnostic duration");
  const drainRegistry = new DaemonRegistry({ getWebSockets: () => [probing] });
  assert(drainRegistry.beginDrain(probing) === true && drainRegistry.attachment(probing)?.draining === true,
    "planned daemon drain was not serialized into the hibernation-safe socket attachment");
  const rehydratedRegistry = new DaemonRegistry({ getWebSockets: () => [probing] });
  assert(rehydratedRegistry.isDraining(probing) === true && rehydratedRegistry.readyChannels().length === 0,
    "planned daemon drain identity was lost across a simulated Worker isolate replacement");

  const cleanupSocket = new TestWebSocket();
  cleanupSocket.serializeAttachment({
    role: "daemon", connectedAt: "2026-08-04T11:36:29.000Z", lastSeenAt: "2026-08-04T11:36:30.000Z",
    instanceId: "daemon_cleanup_retry_123456", connectionId: `connection_${"C".repeat(43)}`,
  });
  const cleanupRegistry = new DaemonSocketRegistry({ getWebSockets: () => [cleanupSocket] });
  let rejectCleanup;
  let cleanupCalls = 0;
  const cleanupFailure = new Promise((_resolve, reject) => { rejectCleanup = reject; });
  const firstCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => {
    cleanupCalls += 1;
    await cleanupFailure;
  });
  const duplicateCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 100; });
  assert(firstCleanup?.first === true && duplicateCleanup?.first === false
    && firstCleanup.task === duplicateCleanup.task,
  "concurrent daemon cleanup did not share one ownership task");
  await Promise.resolve();
  rejectCleanup(new Error("synthetic relay detach failure"));
  await expectReject(firstCleanup.task, "synthetic relay detach failure");
  const retryCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 1; });
  assert(retryCleanup?.first === false, "failed daemon cleanup retry duplicated the disconnected transition");
  await retryCleanup.task;
  const settledCleanup = cleanupRegistry.beginCleanup(cleanupSocket, async () => { cleanupCalls += 100; });
  await settledCleanup.task;
  assert(cleanupCalls === 3 && settledCleanup.first === false,
    "daemon cleanup failure was not retryable or successful cleanup ran more than once");
}

async function testWorkerStaticRoutes() {
  const identity = { server: "machine-bridge-mcp", version: "3.0.0-beta.18" };
  const health = respondWithoutDurableObject(new Request("https://example.test/healthz"), identity);
  assert(health?.status === 200, "healthz must be served without Durable Object state");
  assert((await health.json()).version === identity.version, "healthz version must match package identity");

  const root = respondWithoutDurableObject(new Request("https://example.test/"), identity);
  assert(root?.status === 200, "root must be served without Durable Object state");
  assert((await root.json()).mcp === "https://example.test/mcp", "root must advertise the MCP path");

  const preflight = respondWithoutDurableObject(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, dpop, mcp-protocol-version, mcp-method, mcp-name",
    },
  }), identity);
  assert(preflight?.status === 204, "CORS preflight must not depend on Durable Object state");
  assert(preflight.headers.get("access-control-allow-origin") === "https://chatgpt.com", "CORS preflight lost origin allowlist");
  for (const removedHeader of ["last-event-id", "mcp-session-id"]) {
    const removedPreflight = respondWithoutDurableObject(new Request("https://example.test/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://chatgpt.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `authorization, ${removedHeader}`,
      },
    }), identity);
    assert(removedPreflight?.status === 403, `CORS still admitted removed ${removedHeader}`);
  }
  const corsResponse = applyCors(new Response("ok"), new Request("https://example.test/mcp", {
    headers: { Origin: "https://chatgpt.com" },
  }), "https://example.test", "https://chatgpt.com");
  assert(corsResponse.headers.get("access-control-expose-headers") === "www-authenticate",
    "CORS response still exposed a removed MCP session header");

  const undeclaredParameterHeader = respondWithoutDurableObject(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, mcp-param-secret",
    },
  }), identity);
  assert(undeclaredParameterHeader?.status === 403, "CORS reflected an undeclared MCP parameter header");

  const declaredParameterHeader = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, Mcp-Param-Region",
    },
  }), "https://example.test", "", new Set(["mcp-param-region"]));
  assert(declaredParameterHeader.status === 204
    && declaredParameterHeader.headers.get("access-control-allow-headers")?.includes("mcp-param-region"),
  "CORS rejected a schema-declared MCP parameter header");

  const malformedParameterHeader = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, invalid header",
    },
  }), "https://example.test", "");
  assert(malformedParameterHeader.status === 400, "CORS accepted a malformed requested header name");

  const excessiveNames = Array.from({ length: 65 }, (_, index) => `mcp-param-${index}`);
  const excessiveParameterHeaders = corsPreflight(new Request("https://example.test/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://chatgpt.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": excessiveNames.join(","),
    },
  }), "https://example.test", "", new Set(excessiveNames));
  assert(excessiveParameterHeaders.status === 400, "CORS accepted an excessive requested-header set");

  for (const path of ["/.well-known/mcp.json", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    const metadata = respondWithoutDurableObject(new Request(`https://example.test${path}`), identity);
    assert(metadata?.status === 200, `${path} unexpectedly consumed Durable Object state`);
  }
  const missing = respondWithoutDurableObject(new Request("https://example.test/random-scan-path"), identity);
  assert(missing?.status === 404, "unknown public route reached the Durable Object");

  for (const [path, method] of [
    ["/mcp", "POST"], ["/mcp", "GET"], ["/daemon/ws", "GET"], ["/oauth/token", "POST"],
    ["/oauth/authorize", "GET"], ["/oauth/authorize", "POST"], ["/oauth/register", "POST"],
    ["/admin/accounts", "GET"], ["/admin/accounts", "PATCH"], ["/admin/clients", "DELETE"],
  ]) {
    const passthrough = respondWithoutDurableObject(new Request(`https://example.test${path}`, { method }), identity);
    assert(passthrough === null, `${method} ${path} no longer reaches stateful routing`);
  }
  for (const [path, method, allow] of [
    ["/mcp", "HEAD", "GET, POST"], ["/daemon/ws", "POST", "GET"], ["/oauth/token", "DELETE", "POST"],
    ["/admin/clients", "PATCH", "GET, DELETE"],
  ]) {
    const rejected = respondWithoutDurableObject(new Request(`https://example.test${path}`, { method }), identity);
    assert(rejected?.status === 405 && rejected.headers.get("allow") === allow,
      `${method} ${path} consumed rate-limit or Durable Object capacity before method rejection`);
  }

  let observedGlobalKey = "";
  const globallyAllowed = await admitGlobalStatefulRequest(new Request("https://example.test/mcp"), {
    async limit({ key }) { observedGlobalKey = key; return { success: true }; },
  });
  assert(globallyAllowed === null && observedGlobalKey === "stateful:global:mcp:example.test",
    "global stateful rate limiter lost its route and Worker scope");
  const firstAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }));
  const repeatedAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }));
  const secondAuthenticatedKey = await statefulRateLimitKey(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-two" },
  }));
  assert(firstAuthenticatedKey === repeatedAuthenticatedKey && firstAuthenticatedKey !== secondAuthenticatedKey,
    "stateful rate-limit identity was not stable and isolated per credential");
  assert(!firstAuthenticatedKey.includes("synthetic-secret"), "stateful rate-limit key exposed credential material");
  assert(statefulRouteClass("/mcp") === "mcp"
    && statefulRouteClass("/daemon/ws") === "daemon"
    && statefulRouteClass("/oauth/token") === "oauth"
    && statefulRouteClass("/admin/accounts/private-looking-suffix") === "admin"
    && statefulRouteClass("/private-looking-path") === "other",
  "Worker route classifier lost its bounded low-cardinality logging/rate-limit contract");
  const oauthNetworkKey = await statefulRateLimitKey(new Request("https://example.test/oauth/token", {
    headers: { "cf-connecting-ip": "192.0.2.10" },
  }));
  assert(oauthNetworkKey.startsWith("stateful:oauth:network:") && !oauthNetworkKey.includes("192.0.2.10"),
    "anonymous stateful rate-limit key exposed or mis-scoped the network identity");
  for (const path of ["/oauth/token", "/admin/accounts", "/daemon/ws"]) {
    const withIrrelevantCredential = await statefulRateLimitKey(new Request(`https://example.test${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.10", authorization: "Bearer attacker-selected-bucket" },
    }));
    const withoutCredential = await statefulRateLimitKey(new Request(`https://example.test${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.10" },
    }));
    assert(withIrrelevantCredential === withoutCredential,
      `irrelevant Authorization header bypassed the network rate-limit bucket for ${path}`);
  }
  let observedRateLimitKey = "";
  const allowed = await admitStatefulRequest(new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer synthetic-secret-one" },
  }), { async limit({ key }) { observedRateLimitKey = key; return { success: true }; } });
  assert(allowed === null && observedRateLimitKey === firstAuthenticatedKey,
    "stateful rate limiter rejected an admitted request or used the wrong subject bucket");
  const limited = await admitStatefulRequest(new Request("https://example.test/mcp"), { async limit() { return { success: false }; } });
  assert(limited?.status === 429 && limited.headers.get("retry-after") === "60", "stateful rate limiter lost its retry contract");
  const limiterFailure = await admitStatefulRequest(new Request("https://example.test/mcp"), { async limit() { throw new Error("synthetic limiter outage"); } });
  assert(limiterFailure === null, "rate-limiter outage disconnected authenticated traffic instead of failing open");

  assert(isDurableObjectQuotaError(new Error("Exceeded allowed volume of requests in Durable Objects free tier.")), "quota error detector missed free-tier exhaustion");
  assert(isDurableObjectQuotaError(new Error("outer", { cause: Object.assign(new Error("quota"), { code: "ERR_DURABLE_OBJECT_QUOTA_EXCEEDED" }) })), "quota detector missed a structured nested error");
  assert(!isDurableObjectQuotaError(new Error("socket closed")), "quota error detector over-matched");
  const cyclic = new Error("cyclic");
  cyclic.cause = cyclic;
  assert(!isDurableObjectQuotaError(cyclic), "quota detector did not bound a cyclic cause chain");
  assert(outerWorkerErrorClass(cyclic) === "error", "outer error classification did not bound a cyclic cause chain");
  let deep = Object.assign(new Error("deep"), { code: "DEEPEST" });
  for (let index = 0; index < 12; index += 1) deep = new Error(`level-${index}`, { cause: deep });
  assert(!outerWorkerErrorClass(deep).includes("deepest"), "outer error classification exceeded its cause-depth bound");
  const quota = durableObjectQuotaResponse(new Request("https://example.test/mcp", { headers: { Origin: "https://chatgpt.com" } }));
  assert(quota.status === 503, "quota response must be retryable service unavailable");
  assert((await quota.json()).error === "durable_object_quota_exceeded", "quota response body is wrong");
  const gateway = workerGatewayErrorResponse(new Request("https://example.test/mcp"));
  assert(gateway.status === 502 && (await gateway.json()).error === "worker_gateway_error", "outer Worker did not normalize unexpected failures");
  assert(outerWorkerErrorClass(Object.assign(new Error("secret-value-must-not-appear"), { code: "ECONNRESET" })) === "error:econnreset", "outer error class included sensitive exception text");
}

async function test_outer_async_gateway_failure_escapes() {
 const limiter={limit:async()=>({success:true})};
 const response=await handleOuterWorkerFetch(new Request("https://relay.example.invalid/daemon/http",{method:"POST"}),{
 BRIDGE:{getByName(){return{fetch:async()=>{throw new Error("synthetic gateway failure");}};}},
 STATEFUL_GLOBAL_RATE_LIMITER:limiter,STATEFUL_RATE_LIMITER:limiter}, {waitUntil(){}},{server:"machine-bridge-mcp",version:"3.0.0-test"});
 nodeAssert.equal(response.status,502);
}

async function test_outer_bridge_single_object_routing() {
  const limiter = { limit: async () => ({ success: true }) };
  const requestedObjects = [];
  const fakeEnv = {
    BRIDGE: {
      getByName(name) {
        requestedObjects.push(name);
        return { fetch: async () => new Response("ok", { status: 200 }) };
      },
    },
    STATEFUL_GLOBAL_RATE_LIMITER: limiter,
    STATEFUL_RATE_LIMITER: limiter,
  };
  const ctx = { waitUntil() {} };
  const identity = { server: "machine-bridge-mcp", version: "3.0.0-test" };

  // OAuth clients, tokens, the daemon registry, and pending calls share one
  // consistency domain. A client-supplied name must never select another object:
  // that key is unauthenticated and would fork authoritative state across shards.
  await handleOuterWorkerFetch(new Request("https://relay.example.invalid/daemon/http", { method: "POST" }), fakeEnv, ctx, identity);
  nodeAssert.equal(requestedObjects[0], "default");

  await handleOuterWorkerFetch(new Request("https://relay.example.invalid/daemon/http", {
    method: "POST",
    headers: { "x-mbm-workspace": "project_alpha-1" },
  }), fakeEnv, ctx, identity);
  nodeAssert.equal(requestedObjects[1], "default");

  await handleOuterWorkerFetch(new Request("https://relay.example.invalid/daemon/http?workspace=ws_beta", {
    method: "POST",
  }), fakeEnv, ctx, identity);
  nodeAssert.equal(requestedObjects[2], "default");

  await handleOuterWorkerFetch(new Request("https://relay.example.invalid/mcp", {
    method: "POST",
    headers: { "x-mbm-workspace": "../../../etc/passwd" },
  }), fakeEnv, ctx, identity);
  nodeAssert.equal(requestedObjects[3], "default");
}

async function test_metrics_capacity_recurses() {
 const m=new WorkerObservability();
 for(let i=0;i<160;i++){m.callStarted("tool_"+i);m.callFinished("tool_"+i);}
 const s=m.snapshot();assert(Object.keys(s.tools).length<=128);nodeAssert.equal(s.calls.completed,160);
}

async function test_monitor_rollover_loses_activation() {
 const storage=testDurableStorage();const m=new ManagedJobMonitorClaimStore(storage);
 const a={accountId:"account",accountVersion:1,clientId:"client",familyId:"family",role:"owner"};
 const job="job_"+"a".repeat(43);const id=await m.issue(job,a,100);
 const state=await storage.get("managed-job-monitor-claims-v1");
 state.sequence=Number.MAX_SAFE_INTEGER;await storage.put("managed-job-monitor-claims-v1",state);
 assert(await m.activate(job,id,a,101));assert(await m.claim(job,id,a,102));assert(await m.has(job,id,a,103));
}

async function test_probing_https_candidate_can_drain() {
 const r=new DaemonRegistry({getWebSockets(){return[];}});
 const c=r.http.beginCandidate("relay_http_"+"a".repeat(43),{role:"candidate",instanceId:"instance",connectedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()});
 r.http.activate(c.sessionId,c.activationToken);
 nodeAssert.equal(r.beginDrain(c),false);
}


async function test_daemon_http_channel_controls_and_budgeting() {
  {
    const channel = new DaemonHttpChannel({ sessionId: "synthetic", activationToken: "synthetic",
      attachment: { role: "candidate", connectedAt: new Date().toISOString() } });
    channel.activate(); channel.verifyReady();
    const records = Array.from({ length: 130 }, (_, i) => ({ id: `revoke_${i.toString(36).padStart(43, "0")}`,
      account_id: SYNTHETIC_ACCOUNT_ID, account_version: 1, queued_at: 1 }));
    queueDaemonHttpRevocations(channel, records);
    queueDaemonHttpRevocations(channel, records);
    assert(channel.readyState === 1 && channel.queuedMessageCount === 64,
      "control backlog invalidated or duplicated a healthy HTTPS channel");
    assert(channel.acknowledgeWorker(64), "HTTPS control batch acknowledgement was rejected");
    queueDaemonHttpRevocations(channel, records.slice(64));
    assert(channel.queuedMessageCount === 64 && channel.outboundMessages()[0].seq === 65,
      "deferred controls did not refill in sequence");
    const diagnostics = sanitizeDaemonRelayDiagnostics({ schema_version: 1, recent_outages: [{ outage_number: 1, close_code: null }] });
    assert(diagnostics.recent_outages[0].close_code === null, "unknown outage close code became a real zero code");
  }

  {
    const channel = new DaemonHttpChannel({ sessionId: "synthetic", activationToken: `activate_${"a".repeat(43)}`,
      attachment: { role: "candidate", connectedAt: new Date().toISOString() } });
    channel.activate();
    const first = JSON.stringify({ data: "x".repeat(relayContract.httpFallbackMaximumMessageBytes - 11) });
    const second = JSON.stringify({ data: "y".repeat(relayContract.httpFallbackMaximumEnvelopeBytes
      - relayContract.httpFallbackMaximumMessageBytes - 11) });
    channel.send(first); channel.send(second);
    const messages = channel.outboundMessages();
    const envelope = JSON.stringify({ protocol: 1, phase: "probing", activation_token: channel.activationToken,
      ack_daemon_seq: Number.MAX_SAFE_INTEGER, messages });
    assert(messages.length === 1 && Buffer.byteLength(envelope) <= relayContract.httpFallbackMaximumEnvelopeBytes,
      "HTTPS response envelope omitted sequence/header overhead from its byte budget");
    assert(channel.acknowledgeWorker(messages[0].seq) && channel.outboundMessages()[0].seq === 2,
      "HTTPS envelope budgeting lost or skipped the deferred message");
  }
}

export async function runDaemonWaitersAndRoutesScenarios() {
  await testDaemonReadyWaiters();
  await testAbortSignalCleanup();
  await testDaemonSocketIsolation();
  await testWorkerStaticRoutes();
  await test_outer_async_gateway_failure_escapes();
  await test_outer_bridge_single_object_routing();
  await test_metrics_capacity_recurses();
  await test_monitor_rollover_loses_activation();
  await test_probing_https_candidate_can_drain();
  await test_daemon_http_channel_controls_and_budgeting();
}
