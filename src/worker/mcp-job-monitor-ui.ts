import { cacheableResult, McpProtocolError } from "../shared/mcp-protocol.mjs";
import { rpcError, rpcResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";

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

export function managedJobMonitorResources(serverInfo: Record<string, unknown>): Record<string, unknown> {
  return cacheableResult({ resources: [RESOURCE] }, { ttlMs: 0, cacheScope: "public", serverInfo });
}

export function managedJobMonitorResource(uri: unknown, serverInfo: Record<string, unknown>): Record<string, unknown> {
  if (uri !== JOB_MONITOR_RESOURCE_URI) throw new McpProtocolError(-32602, "Resource not found", { uri: typeof uri === "string" ? uri : "" });
  return cacheableResult({
    contents: [{
      uri: JOB_MONITOR_RESOURCE_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: WIDGET_HTML,
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
): Readonly<{ status: number; message: Record<string, unknown> }> | null {
  if (request.method === "resources/list") {
    return { status: 200, message: rpcResult(request.id, managedJobMonitorResources(serverInfo))! };
  }
  if (request.method !== "resources/read") return null;
  try {
    return {
      status: 200,
      message: rpcResult(request.id, managedJobMonitorResource(objectValue(request.params).uri, serverInfo))!,
    };
  } catch (error) {
    if (error instanceof McpProtocolError) {
      return { status: 400, message: rpcError(request.id, error.code, error.message, error.data) };
    }
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
    status_polling_mode: "ui_monitor", host_turn_handoff_recommended: false, same_response_followup_supported: false,
    completion_delivery: "mcp_app_job_monitor", ui_resource_uri: JOB_MONITOR_RESOURCE_URI,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
