import { createServer } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runExecutable } from "../src/local/shell.mjs";

const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function runOfficialMcpConformance(options) {
  const checkout = validateConformanceCheckout(options.checkout);
  const upstream = validatedUpstream(options.upstream);
  const accessToken = boundedSecret(options.accessToken, "access token", 16 * 1024);
  const scenario = requiredText(options.scenario, "conformance scenario");
  const specVersion = String(options.specVersion || "2026-07-28");
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const proxy = await startBearerProxy({ upstream, accessToken });
  try {
    const npmCli = requiredText(process.env.npm_execpath, "npm_execpath");
    const result = await runCommand({
      command: process.execPath,
      args: [
        npmCli, "start", "--", "server", "--url", `${proxy.origin}/mcp`,
        "--scenario", scenario, "--spec-version", specVersion,
        ...(options.expectedFailures ? ["--expected-failures", String(options.expectedFailures)] : []),
        ...(options.verbose === true ? ["--verbose"] : []),
      ],
      cwd: checkout,
      timeoutMs,
    });
    return Object.freeze({ ...result, scenario, specVersion, proxyOrigin: proxy.origin });
  } finally {
    await proxy.close();
  }
}

async function startBearerProxy({ upstream, accessToken }) {
  const server = createServer((request, response) => {
    void proxyRequest(request, response, upstream, accessToken);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("conformance proxy did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections?.();
    }),
  };
}

async function proxyRequest(request, response, upstream, accessToken) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  try {
    const body = await readBoundedBody(request, MAX_PROXY_REQUEST_BYTES);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${accessToken}`);
    const target = conformanceProxyTarget(request.url, upstream);
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers,
      body: body.length ? body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const responseHeaders = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) responseHeaders[name] = value;
    });
    response.writeHead(upstreamResponse.status, responseHeaders);
    if (!upstreamResponse.body) return response.end();
    const reader = upstreamResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !response.write(Buffer.from(value))) {
          await new Promise((resolve) => { response.once("drain", resolve); });
        }
      }
      response.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted) return response.destroy();
    if (!response.headersSent) response.writeHead(error?.code === "request_too_large" ? 413 : 502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "conformance_proxy_failure" }));
  }
}

function readBoundedBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
      callback(value);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        const error = new Error("conformance proxy request is too large");
        error.code = "request_too_large";
        finish(reject, error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, bytes));
    const onAborted = () => finish(reject, proxyInputError("conformance proxy request was aborted"));
    const onError = (error) => finish(reject, error);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

async function runCommand({ command, args, cwd, timeoutMs }) {
  const result = await runExecutable(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    capture: true,
    allowFailure: true,
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  return Object.freeze({ ...result, signal: null });
}

export function validateConformanceCheckout(value) {
  const requested = resolve(requiredText(value, "conformance checkout"));
  if (!existsSync(requested)) throw new Error("conformance checkout does not exist");
  const requestedInfo = lstatSync(requested);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
    throw new Error("conformance checkout must be a real directory");
  }
  const checkout = realpathSync.native(requested);
  for (const file of ["package.json", "package-lock.json"]) {
    const path = join(checkout, file);
    if (!existsSync(path)) throw new Error(`conformance checkout omits ${file}`);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`conformance checkout ${file} must be a regular file`);
  }
  let packageState;
  try { packageState = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")); }
  catch { throw new Error("conformance checkout package.json is invalid"); }
  if (typeof packageState?.scripts?.start !== "string" || !packageState.scripts.start.trim()) {
    throw new Error("conformance checkout omits its start command");
  }
  const nodeModules = join(checkout, "node_modules");
  if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) {
    throw new Error("conformance checkout dependencies are not installed; run npm ci --ignore-scripts in the checkout");
  }
  return checkout;
}

export function conformanceProxyTarget(requestTarget, upstream) {
  const raw = String(requestTarget || "/mcp");
  if (Buffer.byteLength(raw) > 8192) throw proxyInputError("conformance proxy request target is too large");
  let parsed;
  try { parsed = new URL(raw, "http://proxy.invalid"); }
  catch { throw proxyInputError("conformance proxy request target is invalid"); }
  if (parsed.origin !== "http://proxy.invalid" || parsed.hash) {
    throw proxyInputError("conformance proxy requires a relative request target");
  }
  if (parsed.pathname !== "/mcp") throw proxyInputError("conformance proxy accepts only its MCP endpoint");
  const target = new URL(upstream.href);
  if (parsed.search) target.search = parsed.search;
  return target;
}

function validatedUpstream(value) {
  let upstream;
  try { upstream = new URL(requiredText(value, "upstream MCP URL")); }
  catch { throw new Error("upstream MCP URL is invalid"); }
  if (upstream.username || upstream.password || upstream.hash) throw new Error("upstream MCP URL must not contain credentials or a fragment");
  const loopback = upstream.hostname === "localhost" || upstream.hostname === "127.0.0.1" || upstream.hostname === "[::1]";
  if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && loopback)) {
    throw new Error("upstream MCP URL must use HTTPS or loopback HTTP");
  }
  return upstream;
}

function boundedSecret(value, label, maximumBytes) {
  const text = requiredText(value, label);
  if (Buffer.byteLength(text) > maximumBytes) throw new Error(`${label} is too large`);
  return text;
}

function proxyInputError(message) {
  const error = new Error(message);
  error.code = "invalid_proxy_input";
  return error;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function main() {
  const result = await runOfficialMcpConformance({
    checkout: process.env.MBM_OFFICIAL_CONFORMANCE_CHECKOUT,
    upstream: process.env.MBM_OFFICIAL_CONFORMANCE_UPSTREAM,
    accessToken: process.env.MBM_OFFICIAL_CONFORMANCE_ACCESS_TOKEN,
    scenario: process.env.MBM_OFFICIAL_CONFORMANCE_SCENARIO,
    specVersion: process.env.MBM_OFFICIAL_CONFORMANCE_SPEC_VERSION || "2026-07-28",
    timeoutMs: process.env.MBM_OFFICIAL_CONFORMANCE_TIMEOUT_MS,
    verbose: process.env.MBM_OFFICIAL_CONFORMANCE_VERBOSE === "1",
    expectedFailures: process.env.MBM_OFFICIAL_CONFORMANCE_BASELINE,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
