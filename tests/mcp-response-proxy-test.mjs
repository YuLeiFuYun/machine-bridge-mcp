import { MCP_PROTOCOL_VERSION } from "../src/shared/mcp-protocol.mjs";
import { acceptsEventStream } from "../src/worker/mcp-http-accept.ts";
import { proxyMcpResponseStream } from "../src/worker/mcp-response-proxy.ts";
import {
  MCP_STREAM_PROXY_ID_HEADER,
  MCP_STREAM_PROXY_MODE_HEADER,
  mcpStreamProxyId,
  mcpStreamProxyMode,
} from "../src/worker/mcp-stream-proxy-contract.ts";

await testPublicReaderCancellation();
await testRequestSignalCancellation();
await testEarlyRequestAbort();
await testNonStreamPassthrough();
await testUpstreamCompletion();
await testUpstreamFailure();
await testCancellationDeliveryFailure();
await testEligibility();
testAcceptNegotiation();
console.log("MCP response proxy test ok");

async function testPublicReaderCancellation() {
  const fixture = proxyFixture();
  const response = await proxyMcpResponseStream(fixture.input);
  assert(response?.status === 200, "eligible MCP response was not proxied");
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert(first === ": upstream\n\n", "proxied stream lost its first upstream frame");
  await reader.cancel("consumer closed response");
  await fixture.settle();
  assertCancellationPair(fixture.requests, "reader cancellation");
}

async function testRequestSignalCancellation() {
  const controller = new AbortController();
  const fixture = proxyFixture(controller.signal);
  const response = await proxyMcpResponseStream(fixture.input);
  assert(response?.body, "request-signal fixture did not create a response body");
  controller.abort("request aborted");
  await fixture.settle();
  assertCancellationPair(fixture.requests, "request abort");
  const reader = response.body.getReader();
  const first = await reader.read();
  const terminal = first.done ? first : await reader.read();
  assert(terminal.done === true, "request abort left the public response stream open after queued data drained");
}

async function testEarlyRequestAbort() {
  const controller = new AbortController();
  const requests = [];
  const retained = [];
  let directStarted;
  const started = new Promise((resolve) => { directStarted = resolve; });
  const bridge = {
    async fetch(request) {
      requests.push(request);
      if (mcpStreamProxyMode(request) === "cancel") return new Response(null, { status: 202 });
      directStarted();
      return await new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error(String(request.signal.reason))), { once: true });
      });
    },
  };
  const pending = proxyMcpResponseStream({
    request: currentRequest(controller.signal),
    bridge,
    ctx: { waitUntil(promise) { retained.push(Promise.resolve(promise)); } },
  });
  await started;
  controller.abort("early request abort");
  await expectReject(pending, "early request abort");
  await Promise.all(retained);
  assertCancellationPair(requests, "early request abort");
}

async function testNonStreamPassthrough() {
  const requests = [];
  const bridge = {
    async fetch(request) {
      requests.push(request);
      return new Response(null, { status: 204, headers: { "x-current": "passthrough" } });
    },
  };
  const response = await proxyMcpResponseStream({
    request: currentRequest(), bridge, ctx: { waitUntil() { throw new Error("passthrough scheduled cancellation"); } },
  });
  assert(response?.status === 204 && response.headers.get("x-current") === "passthrough",
    "non-stream upstream response was not returned unchanged");
  assert(requests.length === 1 && mcpStreamProxyMode(requests[0]) === "direct",
    "non-stream upstream response created a cancellation request");

  const jsonResponse = await proxyMcpResponseStream({
    request: currentRequest(),
    bridge: { async fetch() { return Response.json({ ok: true }, { status: 202 }); } },
    ctx: { waitUntil() { throw new Error("JSON passthrough scheduled cancellation"); } },
  });
  assert(jsonResponse?.status === 202 && (await jsonResponse.json()).ok === true,
    "non-SSE response body was not passed through");
}

async function testUpstreamCompletion() {
  const requests = [];
  const response = await proxyMcpResponseStream({
    request: currentRequest(),
    bridge: {
      async fetch(request) {
        requests.push(request);
        return new Response(new ReadableStream({
          start(target) {
            target.enqueue(new TextEncoder().encode("data: complete\n\n"));
            target.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    },
    ctx: { waitUntil() { throw new Error("completed upstream scheduled cancellation"); } },
  });
  const reader = response.body.getReader();
  assert(new TextDecoder().decode((await reader.read()).value) === "data: complete\n\n",
    "completed upstream lost its terminal frame");
  assert((await reader.read()).done === true, "completed upstream left the public stream open");
  assert(requests.length === 1, "normal upstream completion issued a cancellation request");
}

async function testUpstreamFailure() {
  const requests = [];
  const retained = [];
  let failUpstream;
  const response = await proxyMcpResponseStream({
    request: currentRequest(),
    bridge: {
      async fetch(request) {
        requests.push(request);
        if (mcpStreamProxyMode(request) === "cancel") return new Response(null, { status: 202 });
        return new Response(new ReadableStream({
          start(target) {
            target.enqueue(new TextEncoder().encode("data: before-error\n\n"));
            failUpstream = (error) => target.error(error);
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    },
    ctx: { waitUntil(promise) { retained.push(Promise.resolve(promise)); } },
  });
  const reader = response.body.getReader();
  assert(new TextDecoder().decode((await reader.read()).value) === "data: before-error\n\n",
    "upstream failure fixture lost the frame before the failure");
  failUpstream(new Error("synthetic upstream failure"));
  await expectReject(reader.read(), "synthetic upstream failure");
  await Promise.all(retained);
  assertCancellationPair(requests, "upstream stream failure");
}

async function testCancellationDeliveryFailure() {
  const fixture = proxyFixture(undefined, { cancelFails: true });
  const response = await proxyMcpResponseStream(fixture.input);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel("consumer closed while control path unavailable");
  await fixture.settle();
  assertCancellationPair(fixture.requests, "failed cancellation delivery");
}

async function testEligibility() {
  const bridge = { async fetch() { throw new Error("ineligible request reached bridge"); } };
  const ctx = { waitUntil() {} };
  const missingVersion = new Request("https://example.test/mcp", {
    method: "POST", headers: { accept: "text/event-stream" }, body: "{}",
  });
  assert(await proxyMcpResponseStream({ request: missingVersion, bridge, ctx }) === null,
    "request without the current protocol version entered stream proxying");
  const initializationCompatibility = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: "{}",
  });
  assert(await proxyMcpResponseStream({ request: initializationCompatibility, bridge, ctx }) === null,
    "initialization-era compatibility request entered the 2026 response stream proxy");
  const jsonOnly = currentRequest(undefined, "application/json");
  assert(await proxyMcpResponseStream({ request: jsonOnly, bridge, ctx }) === null,
    "JSON-only request entered stream proxying");
  const wrongMethod = new Request("https://example.test/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
  });
  assert(await proxyMcpResponseStream({ request: wrongMethod, bridge, ctx }) === null,
    "non-POST request entered stream proxying");
}

function testAcceptNegotiation() {
  const accepts = (value) => acceptsEventStream({ headers: new Headers(value === undefined ? {} : { accept: value }) });
  assert(!accepts(undefined), "missing Accept unexpectedly selected SSE");
  assert(!accepts("application/json"), "JSON-only Accept unexpectedly selected SSE");
  assert(accepts("text/event-stream"), "plain SSE Accept was rejected");
  assert(accepts("application/json, TEXT/EVENT-STREAM; charset=utf-8"), "case-insensitive parameterized SSE Accept was rejected");
  assert(!accepts("text/event-stream; q=0"), "q=0 SSE Accept was treated as acceptable");
  assert(!accepts("text/event-stream; q=bogus"), "invalid SSE quality was treated as acceptable");
  assert(accepts("application/json; q=1, text/event-stream; q=0.1"), "positive SSE quality was rejected");
}

function proxyFixture(signal, options = {}) {
  const requests = [];
  const retained = [];
  const bridge = {
    async fetch(request) {
      requests.push(request);
      const mode = mcpStreamProxyMode(request);
      if (mode === "cancel") {
        if (options.cancelFails) throw new Error("synthetic cancellation transport failure");
        return new Response(null, { status: 202 });
      }
      assert(mode === "direct", `unexpected internal proxy mode: ${mode}`);
      const body = new ReadableStream({
        start(target) { target.enqueue(new TextEncoder().encode(": upstream\n\n")); },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    },
  };
  const input = {
    request: currentRequest(signal),
    bridge,
    ctx: { waitUntil(promise) { retained.push(Promise.resolve(promise)); } },
  };
  return { input, requests, async settle() { await Promise.all(retained); await Promise.resolve(); } };
}

function currentRequest(signal, accept = "application/json, text/event-stream") {
  return new Request("https://example.test/mcp", {
    method: "POST",
    signal,
    headers: {
      accept,
      "content-type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      Authorization: "Bearer public-secret",
      DPoP: "public-proof",
      [MCP_STREAM_PROXY_MODE_HEADER]: "cancel",
      [MCP_STREAM_PROXY_ID_HEADER]: `stream_${"S".repeat(43)}`,
    },
    body: "{}",
  });
}

function assertCancellationPair(requests, label) {
  assert(requests.length === 2, `${label} did not issue exactly one direct and one cancel request`);
  const [direct, cancel] = requests;
  assert(mcpStreamProxyMode(direct) === "direct", `${label} lost the direct internal mode`);
  assert(mcpStreamProxyMode(cancel) === "cancel", `${label} lost the cancel internal mode`);
  const streamId = mcpStreamProxyId(direct);
  assert(/^stream_[A-Za-z0-9_-]{43}$/.test(streamId), `${label} did not mint a bounded stream capability`);
  assert(streamId !== `stream_${"S".repeat(43)}`, `${label} trusted a caller-supplied internal stream capability`);
  assert(mcpStreamProxyId(cancel) === streamId, `${label} did not bind cancellation to the direct stream capability`);
  assert(direct.headers.get("authorization") === "Bearer public-secret", `${label} stripped authorization from the direct request`);
  assert(cancel.headers.get("authorization") === null && cancel.headers.get("dpop") === null,
    `${label} copied public credentials into the private cancellation control`);
}

async function expectReject(promise, text) {
  try { await promise; }
  catch (error) {
    if (String(error?.message || error).includes(text)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${text}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
