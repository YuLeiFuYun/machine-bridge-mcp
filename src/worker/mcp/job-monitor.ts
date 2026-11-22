import type { AuthorizedToken } from "../oauth/authority.ts";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "../room/errors.ts";
import { verifyManagedJobCapability } from "../room/managed-job-contract.ts";
import type { AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import { JOB_MONITOR_CLAIM_TTL_MS, ManagedJobMonitorClaimStore } from "./job-monitor-store.ts";
import { cacheableResult, McpProtocolError } from "../../shared/mcp-protocol.mjs";
import { rpcError, rpcResult, type JsonRpcRequest } from "./jsonrpc.ts";
import { CODE_MODE_SDK_RESOURCE_URI, HELP_RESOURCES, helpResourceMimeType, readHelpResource } from "../../shared/help-resources.mjs";

export const JOB_MONITOR_RENDER_TOOL = "render_job_monitor";

export const JOB_MONITOR_CLAIM_TOOL = "claim_job_monitor";

export const JOB_MONITOR_READ_TOOL = "read_job_monitor";

const JOB_ID = /^job_[A-Za-z0-9_-]{24,}$/;

const RECOVERY_KEY = { type: "string", pattern: "^mcp_jr_[A-Za-z0-9_-]{43}$" };

const JOB_ID_SCHEMA = { type: "string", pattern: "^job_[A-Za-z0-9_-]{24,}$" };

export function managedJobMonitorRenderToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_RENDER_TOOL,
    title: "Render managed job monitor",
    description: "Optionally render the durable-job monitor after an active start_job reports ui_monitor_candidate=true, but only when the current assistant task can deliberately transfer this job's status polling without needing its terminal result for remaining same-response work. If the current task still depends on the job result, do not render the monitor; preserve job_id plus recovery_key and continue server-paced read_job follow-up instead. When intentionally rendering, pass the exact job_id, recovery_key, and ui_monitor_id already returned by start_job. This tool verifies existing read authority, activates that pre-issued monitor ID, and mounts UI; it does not execute, cancel, mutate the job, or transfer ownership of unrelated assistant work. Do not depend on this render tool's result being visible to the planner. Immediately call read_job once with the same pre-issued ui_monitor_id to confirm whether the View claimed polling ownership. A successful claim stops duplicate model-side polling of this job only. For an ordinary job it is not by itself a reason to end the assistant response. For an explicitly persisted task_supervisor, only a later read_job that proves the current claim and reports host_turn_handoff_recommended=true permits host-turn handoff because the supervisor job already owns all remaining noninteractive task work; the monitor itself still has no execution authority.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN }, ui_monitor_claim_required: { type: "boolean" }, follow_up_read_required: { type: "boolean" } }, required: ["job_id", "ui_monitor_id", "ui_monitor_claim_required", "follow_up_read_required"], additionalProperties: true },
    _meta: {
      ui: { resourceUri: JOB_MONITOR_RESOURCE_URI, visibility: ["model"] },
      "ui/resourceUri": JOB_MONITOR_RESOURCE_URI,
      "openai/outputTemplate": JOB_MONITOR_RESOURCE_URI,
    },
  };
}

export function managedJobMonitorClaimToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_CLAIM_TOOL,
    title: "Claim managed job monitor",
    description: "App-only lifecycle handshake proving that one mounted managed-job monitor instance can call server tools. It validates the existing hosted read capability plus render-instance ID and records only a short-lived continuation claim; it does not execute or mutate the managed job.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  };
}

export function managedJobMonitorReadToolDefinition(): Record<string, unknown> {
  return {
    name: JOB_MONITOR_READ_TOOL,
    title: "Read managed job monitor status",
    description: `App-only status continuation for the latest claimed durable managed-job monitor. It verifies the original principal-bound recovery capability, requires the non-authority monitor correlation ID to identify the latest claimed View, refreshes its short-lived handoff-freshness lease, and performs one fixed ${Number(relayContract.defaultManagedJobReadWaitMs) / 1000}-second server-paced read of the underlying job. Its response is a privacy-bounded status projection and never includes step output, command text, paths, or recovery/control capabilities. A still-latest View may resume after that freshness lease elapsed; issuing a replacement monitor retires the older View. The View may retry a transient failed read with the same capability; it never resubmits the managed job itself.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, recovery_key: RECOVERY_KEY, ui_monitor_id: { type: "string", pattern: JOB_MONITOR_ID_PATTERN } }, required: ["job_id", "recovery_key", "ui_monitor_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { job_id: JOB_ID_SCHEMA, status: { type: "string" }, current_phase: { type: "string" }, current_step: { type: "integer", minimum: 0 }, dependency_total: { type: "integer", minimum: 0 }, dependency_pending_count: { type: "integer", minimum: 0 }, finished_at: { type: "string" }, error_class: { type: "string" } }, required: ["job_id", "status"], additionalProperties: false },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  };
}

export async function renderManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  if (!jobId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!monitorId || !await activateManagedJobMonitor(store, jobId, monitorId, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor ID was not issued for this active start_job", false, { side_effects_started: false });
  }
  return {
    $mcpText: "",
    job_id: jobId,
    ui_monitor_id: monitorId,
    ui_monitor_claim_required: true,
    follow_up_read_required: true,
  };
}

export async function managedJobMonitorReadDaemonArguments(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  if (!jobId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  if (!validManagedJobMonitorId(args.ui_monitor_id)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor correlation ID is invalid", false, { side_effects_started: false });
  }
  if (!await refreshManagedJobMonitorClaim(store, jobId, args.ui_monitor_id, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor claim is not current", false, { side_effects_started: false });
  }
  return { job_id: jobId, wait_ms: Number(relayContract.defaultManagedJobReadWaitMs) };
}
export { JOB_MONITOR_CLAIM_TTL_MS, ManagedJobMonitorClaimStore } from "./job-monitor-store.ts";

export const JOB_MONITOR_ID_PATTERN = "^mcp_jm_[a-f0-9]{32}$";

const MONITOR_ID = /^mcp_jm_[a-f0-9]{32}$/;

export type ManagedJobMonitorCoordinationOperation = "issue" | "claim_probe" | "revocation_cleanup";

export type ManagedJobMonitorCoordinationFailureObserver = (operation: ManagedJobMonitorCoordinationOperation, error: unknown) => void;

export async function issueManagedJobMonitorIfAvailable(
  store: ManagedJobMonitorClaimStore, jobId: string, authorized: AuthorizedToken,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<string | null> {
  try { return await store.issue(jobId, authorized); }
  catch (error) { observeCoordinationFailure(observeFailure, "issue", error); return null; }
}

export function activateManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, jobId: string, monitorId: string, authorized: AuthorizedToken,
): Promise<boolean> {
  return store.activate(jobId, monitorId, authorized);
}

export async function claimManagedJobMonitor(
  store: ManagedJobMonitorClaimStore, args: Record<string, unknown>, authorized: AuthorizedToken, keyMaterial: string,
): Promise<Record<string, unknown>> {
  const jobId = typeof args.job_id === "string" && JOB_ID.test(args.job_id) ? args.job_id : "";
  const monitorId = validManagedJobMonitorId(args.ui_monitor_id) ? args.ui_monitor_id : "";
  if (!jobId || !monitorId || !await verifyManagedJobCapability(keyMaterial, authorized, jobId, "read", args.recovery_key)) {
    throw new WorkerToolError("authorization_denied", "managed-job monitor recovery authority is invalid", false, { side_effects_started: false });
  }
  if (!await store.claim(jobId, monitorId, authorized)) {
    throw new WorkerToolError("invalid_request", "managed-job monitor render instance is not active", false, { side_effects_started: false });
  }
  return { claimed: true, expires_in_ms: JOB_MONITOR_CLAIM_TTL_MS };
}

export function hasManagedJobMonitorClaim(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
): Promise<boolean> {
  return typeof jobId === "string" && JOB_ID.test(jobId) && validManagedJobMonitorId(monitorId)
    ? store.has(jobId, monitorId, authorized) : Promise.resolve(false);
}

export async function hasManagedJobMonitorClaimIfAvailable(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<boolean> {
  try { return await hasManagedJobMonitorClaim(store, jobId, monitorId, authorized); }
  catch (error) { observeCoordinationFailure(observeFailure, "claim_probe", error); return false; }
}

export function refreshManagedJobMonitorClaim(
  store: ManagedJobMonitorClaimStore, jobId: unknown, monitorId: unknown, authorized: AuthorizedToken,
): Promise<boolean> {
  return typeof jobId === "string" && JOB_ID.test(jobId) && validManagedJobMonitorId(monitorId)
    ? store.refresh(jobId, monitorId, authorized) : Promise.resolve(false);
}

export async function cancelManagedJobMonitorClaimsIfAvailable(
  store: ManagedJobMonitorClaimStore, revocation: AuthorityRevocation,
  observeFailure?: ManagedJobMonitorCoordinationFailureObserver,
): Promise<number> {
  try { return await store.cancelAuthority(revocation); }
  catch (error) { observeCoordinationFailure(observeFailure, "revocation_cleanup", error); return 0; }
}

export function validManagedJobMonitorId(value: unknown): value is string {
  return typeof value === "string" && MONITOR_ID.test(value);
}

function observeCoordinationFailure(
  observer: ManagedJobMonitorCoordinationFailureObserver | undefined,
  operation: ManagedJobMonitorCoordinationOperation,
  error: unknown,
): void {
  try { observer?.(operation, error); } catch { /* auxiliary telemetry must not become monitor authority */ }
}
const TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

export function projectManagedJobMonitorStatus(value: unknown, expectedJobId: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStatus();
  const source = value as Record<string, unknown>;
  const jobId = typeof source.job_id === "string" && JOB_ID.test(source.job_id) ? source.job_id : "";
  const status = token(source.status);
  if (!jobId || jobId !== expectedJobId || !status) throw invalidStatus();
  const projected: Record<string, unknown> = { job_id: jobId, status };
  const phase = token(source.current_phase); if (phase) projected.current_phase = phase;
  if (nonnegativeInteger(source.current_step)) projected.current_step = source.current_step;
  if (nonnegativeInteger(source.dependency_total)) projected.dependency_total = source.dependency_total;
  if (nonnegativeInteger(source.dependency_pending_count)) projected.dependency_pending_count = source.dependency_pending_count;
  if (timestamp(source.finished_at)) projected.finished_at = source.finished_at;
  const errorClass = token(source.error_class); if (errorClass) projected.error_class = errorClass;
  return projected;
}

function token(value: unknown): string { return typeof value === "string" && TOKEN.test(value) ? value : ""; }

function nonnegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }

function boundedString(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length <= maximum; }

function timestamp(value: unknown): value is string { return boundedString(value, 64) && Number.isFinite(Date.parse(value)); }

function invalidStatus(): WorkerToolError {
  return new WorkerToolError("execution_failed", "managed-job monitor status is unavailable", true, { side_effects_started: false });
}
export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const JOB_MONITOR_RESOURCE_URI = "ui://machine-bridge/managed-job-monitor-v1.html";

const RESOURCE = Object.freeze({
  uri: JOB_MONITOR_RESOURCE_URI,
  name: "Machine Bridge managed job monitor",
  title: "Managed job monitor",
  description: "Monitor one already-authorized durable Machine Bridge job without keeping the assistant response open.",
  mimeType: MCP_APP_MIME_TYPE,
  _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
});

const TERMINAL_STATUSES = [
  "succeeded", "failed", "cancelled", "succeeded_cleanup_failed", "failed_cleanup_failed",
  "cancelled_cleanup_failed", "recovered", "recovery_failed", "runner_failed", "runner_launch_failed",
  "recovery_exhausted", "cancelled_before_start", "expired_before_start",
];

const WIDGET_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;padding:12px}main{display:grid;gap:8px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.status{font-weight:650}.muted{opacity:.72;font-size:12px}pre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;margin:0;padding:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;font-size:11px}button{font:inherit;padding:5px 9px}button[hidden]{display:none}</style></head>
<body><main><div class="row"><span class="status" id="status">Waiting for job…</span><span class="muted" id="phase"></span></div><div class="muted" id="detail">The durable job continues independently of this chat response.</div><pre id="result" hidden></pre><button id="retry" hidden>Retry status read</button></main>
<script>
(()=>{"use strict";
const terminal=new Set(${JSON.stringify(TERMINAL_STATUSES)}),pending=new Map(),retryDelays=[1000,2000,4000,8000,15000,30000],claimRetryDelays=[1000,2000,4000,8000,15000],initResponseTimeoutMs=30000,readResponseTimeoutMs=60000,claimResponseTimeoutMs=30000;let nextId=1,jobId="",monitorId="",stopped=false,connected=false,serverTools=false,reading=false,claiming=false,claimed=false,recoveryKey="",inputBound=false,retryMode="",retryAttempt=0,retryTimer=0,claimRetryAttempt=0,claimRetryTimer=0;
const status=document.getElementById("status"),phase=document.getElementById("phase"),detail=document.getElementById("detail"),result=document.getElementById("result"),retry=document.getElementById("retry");
function request(method,params,timeoutMs=0){const id=nextId++;window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");return new Promise((resolve,reject)=>{const entry={resolve,reject,timer:0};if(timeoutMs>0)entry.timer=setTimeout(()=>{if(!pending.delete(id))return;reject(new Error("host tool response timeout"));},timeoutMs);pending.set(id,entry);});}
function clearPending(){for(const entry of pending.values())if(entry.timer)clearTimeout(entry.timer);pending.clear();}
function resetReadRetry(){retryAttempt=0;if(retryTimer){clearTimeout(retryTimer);retryTimer=0;}}function pauseRead(message){retryMode="read";detail.textContent=message;retry.hidden=false;}
function scheduleReadRetry(){if(stopped||retryTimer)return;if(retryAttempt>=retryDelays.length){pauseRead("Status read paused after repeated connection failures.");return;}const delay=retryDelays[retryAttempt++];retryMode="read";retry.hidden=true;detail.textContent="Status read interrupted; retrying automatically.";retryTimer=setTimeout(()=>{retryTimer=0;void continueMonitoring();},delay);}
function resetClaimRetry(){claimRetryAttempt=0;if(claimRetryTimer){clearTimeout(claimRetryTimer);claimRetryTimer=0;}}function scheduleClaimRetry(){if(stopped||claimRetryTimer)return;if(claimRetryAttempt>=claimRetryDelays.length){retryMode="claim";detail.textContent="Monitor claim paused after repeated connection failures.";retry.hidden=false;return;}const delay=claimRetryDelays[claimRetryAttempt++];retryMode="claim";retry.hidden=true;detail.textContent="Monitor claim response was interrupted; retrying automatically.";claimRetryTimer=setTimeout(()=>{claimRetryTimer=0;void continueMonitoring();},delay);}
async function connect(){retry.hidden=true;retryMode="";try{const initialized=await request("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"machine-bridge-managed-job-monitor",title:"Managed job monitor",version:"1"},appCapabilities:{}},initResponseTimeoutMs);window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}},"*");connected=true;serverTools=Boolean(initialized?.hostCapabilities?.serverTools);if(!serverTools){detail.textContent="This host rendered the monitor but does not expose app-origin server tools; model-side continuation remains active.";return;}void continueMonitoring();}catch{connected=false;retryMode="connect";detail.textContent="Monitor initialization failed; retry to reconnect.";retry.hidden=false;}}
function displayStatus(value){if(!value||typeof value!=="object")return{};const out={};for(const key of ["status","current_phase","current_step","dependency_total","dependency_pending_count","finished_at","error_class"])if(value[key]!==undefined)out[key]=value[key];return out;}
function acceptInput(value){const input=value?.arguments&&typeof value.arguments==="object"?value.arguments:value;if(!input||typeof input!=="object"||typeof input.job_id!=="string"||typeof input.ui_monitor_id!=="string"||typeof input.recovery_key!=="string")return;if(inputBound){if(input.job_id!==jobId||input.ui_monitor_id!==monitorId||input.recovery_key!==recoveryKey)return;}else{jobId=input.job_id;monitorId=input.ui_monitor_id;recoveryKey=input.recovery_key;inputBound=true;}void continueMonitoring();}
function render(value){if(!value||typeof value!=="object"||typeof value.status!=="string")return;const state=String(value.status);status.textContent="Job "+state;phase.textContent=value.current_phase?"phase: "+value.current_phase:"";const done=terminal.has(state);if(done){resetReadRetry();stopped=true;detail.textContent="Finished"+(value.finished_at?" at "+value.finished_at:"")+".";result.hidden=false;result.textContent=JSON.stringify(displayStatus(value),null,2).slice(0,24000);retry.hidden=true;return;}result.hidden=true;if(!connected)return;if(!serverTools){detail.textContent="This host cannot proxy monitor reads; model-side continuation remains active.";return;}detail.textContent=claimed?"Durable execution is "+state+"; this monitor owns status continuation.":"Durable execution is "+state+"; establishing monitor ownership…";void continueMonitoring();}
async function continueMonitoring(){if(stopped||!connected||!serverTools||!inputBound||!jobId||!monitorId||!recoveryKey)return;if(!claimed){if(claiming||claimRetryTimer)return;claiming=true;try{const response=await request("tools/call",{name:"claim_job_monitor",arguments:{job_id:jobId,recovery_key:recoveryKey,ui_monitor_id:monitorId}},claimResponseTimeoutMs);if(response?.isError){claiming=false;const error=response?.structuredContent?.error;if(error?.retryable===true){scheduleClaimRetry();return;}retryMode="claim";detail.textContent="Monitor claim was rejected; model-side continuation is required.";retry.hidden=false;return;}claimed=true;claiming=false;resetClaimRetry();detail.textContent="Monitor ownership established; waiting for durable completion.";}catch{claiming=false;scheduleClaimRetry();return;}}void follow();}
async function follow(){if(stopped||reading||retryTimer||!claimed||!inputBound||!jobId||!monitorId||!recoveryKey)return;reading=true;try{const response=await request("tools/call",{name:"read_job_monitor",arguments:{job_id:jobId,recovery_key:recoveryKey,ui_monitor_id:monitorId}},readResponseTimeoutMs);if(response?.isError){reading=false;const error=response?.structuredContent?.error;if(error?.retryable===true){scheduleReadRetry();return;}pauseRead("Status read paused because this monitor is no longer current or authorized.");return;}const next=response?.structuredContent;if(!next||typeof next!=="object"){reading=false;pauseRead("Status read paused: monitor returned no structured status.");return;}reading=false;resetReadRetry();render(next);}catch{reading=false;scheduleReadRetry();}}
retry.onclick=()=>{retry.hidden=true;if(retryMode==="connect")void connect();else{resetReadRetry();resetClaimRetry();void continueMonitoring();}};
window.addEventListener("message",event=>{if(event.source!==window.parent)return;const message=event.data;if(!message||message.jsonrpc!=="2.0")return;if(message.id!==undefined&&pending.has(message.id)){const entry=pending.get(message.id);pending.delete(message.id);if(entry.timer)clearTimeout(entry.timer);message.error?entry.reject(message.error):entry.resolve(message.result);return;}if(message.method==="ui/notifications/tool-input"){acceptInput(message.params);return;}if(message.method==="ui/resource-teardown"){stopped=true;resetReadRetry();resetClaimRetry();clearPending();recoveryKey="";jobId="";monitorId="";inputBound=false;if(message.id!==undefined)window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}},"*");}}, {passive:true});
void connect();
})();
</script></body></html>`;

export function supportsManagedJobMonitor(clientCapabilities: unknown): boolean {
  if (!clientCapabilities || typeof clientCapabilities !== "object" || Array.isArray(clientCapabilities)) return false;
  const extensions = (clientCapabilities as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return false;
  const capability = (extensions as Record<string, unknown>)[MCP_UI_EXTENSION_ID];
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return false;
  return Array.isArray((capability as Record<string, unknown>).mimeTypes)
    && ((capability as Record<string, unknown>).mimeTypes as unknown[]).includes(MCP_APP_MIME_TYPE);
}

export function managedJobMonitorClientCapabilities(request: JsonRpcRequest): Record<string, unknown> {
  const params = objectValue(request.params);
  const meta = objectValue(params._meta);
  return objectValue(meta["io.modelcontextprotocol/clientCapabilities"]);
}

export function managedJobMonitorResources(serverInfo: Record<string, unknown>, templates = false): Record<string, unknown> {
  return cacheableResult(templates ? { resourceTemplates: [] } : { resources: [RESOURCE, ...HELP_RESOURCES] }, { ttlMs: 0, cacheScope: "public", serverInfo });
}

export function managedJobMonitorResource(
  uri: unknown,
  serverInfo: Record<string, unknown>,
  toolsForSdk?: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const helpText = readHelpResource(uri, toolsForSdk ?? null);
  if (typeof uri === "string" && helpText !== null) {
    const cacheScope = uri === CODE_MODE_SDK_RESOURCE_URI && Array.isArray(toolsForSdk) ? "private" : "public";
    return cacheableResult({ contents: [{ uri, mimeType: helpResourceMimeType(uri), text: helpText }] }, { ttlMs: 0, cacheScope, serverInfo });
  }
  if (uri !== JOB_MONITOR_RESOURCE_URI) throw new McpProtocolError(-32602, "Resource not found");
  return cacheableResult({
    contents: [{
      uri: JOB_MONITOR_RESOURCE_URI, mimeType: MCP_APP_MIME_TYPE, text: WIDGET_HTML,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Shows live status and a terminal status summary for one durable Machine Bridge managed job.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      },
    }],
  }, { ttlMs: 0, cacheScope: "public", serverInfo });
}

export function dispatchManagedJobMonitorResource(
  request: JsonRpcRequest,
  serverInfo: Record<string, unknown>,
  toolsForSdk?: ReadonlyArray<Record<string, unknown>>,
): Readonly<{ status: number; message: Record<string, unknown> }> | null {
  if (request.method === "resources/list" || request.method === "resources/templates/list") {
    return { status: 200, message: rpcResult(request.id, managedJobMonitorResources(serverInfo, request.method === "resources/templates/list"))! };
  }
  if (request.method !== "resources/read") return null;
  try {
    return { status: 200, message: rpcResult(request.id, managedJobMonitorResource(objectValue(request.params).uri, serverInfo, toolsForSdk))! };
  } catch (error) {
    if (error instanceof McpProtocolError) return { status: 400, message: rpcError(request.id, error.code, error.message, error.data) };
    throw error;
  }
}

export function attachManagedJobMonitorMetadata(definition: Record<string, unknown>): void {
  if (definition.name !== "read_job") return;
  const meta = definition._meta && typeof definition._meta === "object" && !Array.isArray(definition._meta)
    ? structuredClone(definition._meta as Record<string, unknown>) : {};
  const ui = (meta.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui)) ? meta.ui as Record<string, unknown> : {};
  meta.ui = { ...ui, visibility: ["model"] };
  delete meta["openai/widgetAccessible"];
  definition._meta = meta;
}

export function projectManagedJobMonitorHandoff(value: unknown, claimed: boolean): unknown {
  if (!claimed || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (result.same_response_followup_supported !== true && result.follow_up_read_required !== true) return value;
  return {
    ...result, follow_up_read_required: false, ui_follow_up_read_required: true, ui_monitor_claimed: true,
    status_polling_mode: "ui_monitor", host_turn_handoff_recommended: result.continuation_mode === "task_supervisor", same_response_followup_supported: false,
    completion_delivery: "mcp_app_job_monitor", ui_resource_uri: JOB_MONITOR_RESOURCE_URI,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
