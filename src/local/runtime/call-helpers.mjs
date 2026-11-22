import { recordMatchesAuthorityRevocation } from "../../shared/authority-revocation.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createMonotonicDeadline } from "../core/timing.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { waitForManagedJobRead } from "../jobs/projection.mjs";
import { ACTIVE_JOB_STATES } from "../jobs/terminal-base.mjs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { validateArgv, validateShellCommand, durableProcessExecutionTimeoutSeconds, durableRegisteredCommandTimeoutSeconds } from "../process/execution.mjs";
import { workspaceShellCommand } from "../deploy/shell.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{20,96}$/;

const CLIENT_ID = /^mcp_client_[A-Za-z0-9_-]{43}$/;

const FAMILY_ID = /^mcp_family_[A-Za-z0-9_-]{43}$/;

export function bindCallPrincipal(record, principal) {
  if (!record || !principal || typeof principal !== "object") return false;
  if (principal.kind === "local") {
    record.owner_kind = "local";
    return true;
  }
  if (principal.kind !== "account") return false;
  if (typeof principal.accountId !== "string" || !ACCOUNT_ID.test(principal.accountId)
      || !Number.isSafeInteger(principal.accountVersion) || principal.accountVersion <= 0
      || typeof principal.clientId !== "string" || !CLIENT_ID.test(principal.clientId)
      || typeof principal.familyId !== "string" || !FAMILY_ID.test(principal.familyId)) return false;
  record.owner_kind = "account";
  record.owner_account_id = principal.accountId;
  record.owner_account_version = principal.accountVersion;
  record.owner_client_id = principal.clientId;
  record.owner_family_id = principal.familyId;
  return true;
}

export function callIdsForAuthority(records, revocation) {
  return [...records]
    .filter((record) => recordMatchesAuthorityRevocation(record, revocation))
    .map((record) => record.id);
}
const states = new WeakMap();

/** @typedef {{ calls: ReadonlyMap<string, unknown>, cancel: (callId: unknown, reason?: unknown, code?: string) => boolean }} DrainableCallRegistry */

export function assertCallRegistryOpen(registry) {
  if (!stateFor(registry).draining) return;
  throw new BridgeError("unavailable", "runtime is stopping and cannot accept new tool calls", { retryable: true });
}

/** @param {DrainableCallRegistry} registry @param {unknown} [reason] @param {number} [waitMs] */
export async function cancelAllCallsAndWait(registry, reason = "runtime stopped", waitMs = 5_000) {
  const state = stateFor(registry);
  state.draining = true;
  for (const id of [...registry.calls.keys()]) registry.cancel(id, reason);
  const deadline = createMonotonicDeadline(waitMs);
  while (registry.calls.size && !deadline.expired()) {
    await waitForRegistryChange(state, Math.max(1, deadline.remainingMs()));
  }
  if (registry.calls.size) {
    throw new BridgeError("unavailable", "tool call shutdown did not settle before the runtime teardown deadline", {
      retryable: true,
      details: { active_calls: registry.calls.size },
    });
  }
}

export function notifyCallRegistryChanged(registry) {
  for (const waiter of [...stateFor(registry).waiters]) waiter();
}

function stateFor(registry) {
  let state = states.get(registry);
  if (!state) {
    state = { draining: false, waiters: new Set() };
    states.set(registry, state);
  }
  return state;
}

function waitForRegistryChange(state, waitMs) {
  return new Promise((resolvePromise) => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      state.waiters.delete(done);
      resolvePromise();
    };
    state.waiters.add(done);
    timer = setTimeout(done, waitMs);
  });
}
export async function settleManagedJobAcceptance(manager, accepted, context = {}) {
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

export async function settleDurableProcessAcceptance(manager, accepted, context = {}) {
  return settleManagedJobAcceptance(manager, accepted, context);
}
export async function prepareDurableDirectProcess(service, args, context = {}) {
  service.policyGate.assert("run_process");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const argv = validateArgv(args.argv);
  const cwd = await service.resolveExistingPath(args.cwd || ".", context);
  if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "cwd is not a directory");
  return {
    sourceTool: "run_process",
    name: `durable run_process: ${basename(argv[0])}`,
    argv,
    cwd,
    timeoutSeconds: durableProcessExecutionTimeoutSeconds(args.timeout_seconds),
    idempotencyKey,
  };
}

export async function prepareDurableRegisteredProcess(service, args, context = {}) {
  service.policyGate.assert("run_local_command");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const command = await service.resolveLocalCommand(args, context);
  const argv = validateArgv(command.argv);
  const cwd = await service.resolveExistingPath(command.cwd, context);
  if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "registered command cwd is not a directory");
  return {
    sourceTool: "run_local_command",
    name: `durable command: ${String(command.name || basename(argv[0])).slice(0, 96)}`,
    argv,
    cwd,
    timeoutSeconds: durableRegisteredCommandTimeoutSeconds(args, command),
    idempotencyKey,
  };
}

export function prepareDurableShellProcess(service, args, context = {}) {
  service.policyGate.assert("exec_command");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const shell = workspaceShellCommand(validateShellCommand(args?.command));
  return {
    sourceTool: "exec_command",
    name: "durable shell command",
    argv: [shell.cmd, ...shell.args],
    cwd: service.workspace,
    timeoutSeconds: durableProcessExecutionTimeoutSeconds(args.timeout_seconds),
    idempotencyKey,
  };
}

function durableProcessIdempotencyKey(args, context) {
  const key = args?.idempotency_key;
  if (context?.origin === "relay" && key === undefined) {
    throw new BridgeError("invalid_request", "remote durable process execution requires idempotency_key before dispatch so an ambiguous acceptance response can be recovered without duplicate execution", {
      retryable: false,
      details: { side_effects_started: false, recovery_credential_required: "idempotency_key" },
    });
  }
  return key;
}
export function managedJobCreationIntent(task, options = {}) {
  const text = String(task || "");
  return !nonExecutionIntent(text) && !existingManagedJobContinuationIntent(text) && !interactiveProcessIntent(text)
    && (managedJobCommandExecutionIntent(text, options) || durableExecutionIntent(text)
    || keepWorkingIntent(text) || interruptionContinuityIntent(text) || compoundExecutionIntent(text));
}

export function keepWorkingIntent(task) {
  return /keep\s+(?:going|working)|do\s+not\s+stop|don't\s+stop|continue\s+(?:working|until)|不要停(?:下)?|别停(?:下)?|一直继续|除非[^。\n]{0,120}否则不要停(?:下)?/i.test(String(task || ""));
}

export function interactiveProcessIntent(task) {
  const text = String(task || "");
  if (existingManagedJobContinuationIntent(text)) return false;
  return /interactive|stdin|repl|watch|tail|stream(?:ing)?(?: output)?|dev server|实时日志|持续读取|读取.*输出|常驻进程|标准输入|用户输入|键盘输入|等待(?:用户|键盘|终端|标准)?输入|需要(?:用户|键盘|终端|标准)输入|(?<!非)交互(?:式)?(?:输入|进程|会话|终端|模式)/i.test(text);
}

export function durableExecutionIntent(task) {
  return /background|detached|durable|long[- ]?running|overnight|multi[- ]?step|cleanup|finally|后台|持久|长时间|多步骤|清理/i.test(String(task || ""));
}

export function supervisorCompoundIntent(task) {
  return /multi[- ]?(?:step|project|repo|repository)|multiple (?:steps|projects|repos|repositories)|cross[- ]project|batch|多个(?:步骤|项目|仓库)|跨项目|批量/i.test(String(task || ""));
}

export function terminalResultRequiredIntent(task, options = {}) {
  return managedJobCommandExecutionIntent(task, options) || keepWorkingIntent(task) || interruptionContinuityIntent(task)
    || /finish|complete|until done|until complete|verify|validate|deliver|完成|做完|直到完成|验证|交付|收尾/i.test(String(task || ""));
}

export function readOnlyDiagnosticIntent(task) {
  return /server_info|diagnose_runtime|read_file|search_text|git_status|read[- ]?only|只读|检查.*(?:状态|健康|诊断)|查看.*(?:状态|诊断)/i.test(String(task || ""));
}

export function existingManagedJobContinuationIntent(task) {
  const text = String(task || "");
  return /(?:read_job|managed\s+job|existing\s+job|current\s+job|same\s+job|现有任务|已有任务|现有作业|已有作业|当前作业|同一作业|原作业)[^。\n]{0,100}(?:read|poll|follow|continue|resume|until|读取|轮询|继续|恢复|直到)|(?:read|poll|follow|continue|resume|tail|读取|轮询|继续|恢复|持续读取)[^。\n]{0,100}(?:read_job|managed\s+job|existing\s+job|current\s+job|same\s+job|现有任务|已有任务|现有作业|已有作业|当前作业|同一作业|原作业)/i.test(text);
}

export function nonExecutionIntent(task) {
  const text = String(task || "");
  return /read[- ]?only|analysis only|review(?: the)? (?:wording|string|mention|text) only|do not (?:run|execute|launch|start|publish)|don't (?:run|execute|launch|start|publish)|no process execution|(?:only\s+explain|explain(?: it| why)?\s+only)|docs? mention|只读|不运行(?:任务)?|不要(?:执行|运行|启动|发布)|(?:仅|只)(?:解释|说明)(?:它|原因)?|只给建议|仅(?:审查|检查|复核)(?:文字|措辞|内容)?/i.test(text);
}

export function managedJobCommandExecutionIntent(task, options = {}) {
  const match = options.managedJobCommandMatch;
  if (!match || match.execution_mode !== "managed_job" || Number(match.score || 0) < 3 || nonExecutionIntent(task)) return false;
  return /\b(?:run|execute|launch|start|publish)\b|执行|运行|启动|发布/i.test(String(task || ""));
}

export function interruptionContinuityIntent(task) {
  return /interruption|disconnect(?:ed|ion)?|drop(?:ped)?|reconnect|resume|中断|断线|掉线|断开|重连|续跑|恢复执行/i.test(String(task || ""));
}

export function compoundExecutionIntent(task) {
  const text = String(task || "");
  const executionVerb = /process|handle|continue|resume|run|build|test|verify|migrate|repair|implement|处理|继续|续跑|运行|构建|测试|验证|迁移|修复|实现/i.test(text);
  const explicitCompound = /multi[- ]?(?:project|repo|repository)|multiple (?:projects|repos|repositories)|cross[- ]project|batch|多个项目|多个仓库|跨项目|批量/i.test(text);
  const enumeratedCompound = /[、,，].*(?:及|和|与|and)/i.test(text);
  return executionVerb && (explicitCompound || enumeratedCompound);
}

export function buildContinuationContract(task, availableNames, options = {}) {
  if (existingManagedJobContinuationIntent(task)) {
    return {
      task_supervisor: false,
      preferred_surface: availableNames.has("read_job") ? "read_job" : null,
      continuation_mode: null,
      job_shape: null,
      continue_same_response: availableNames.has("read_job") && terminalResultRequiredIntent(task, options),
      stop_conditions: stopConditions(),
      reasons: ["existing_managed_job_continuation"],
    };
  }
  const interactive = interactiveProcessIntent(task);
  const nonExecution = nonExecutionIntent(task);
  const managedCommand = managedJobCommandExecutionIntent(task, options);
  const reasons = [
    managedCommand && "managed_command_execution_intent",
    keepWorkingIntent(task) && "explicit_keep_working_intent",
    interruptionContinuityIntent(task) && "interruption_continuity_intent",
    supervisorCompoundIntent(task) && "compound_execution_intent",
    durableExecutionIntent(task) && "durable_process_intent",
    nonExecution && "non_execution_intent",
    interactive && "interactive_process_excluded",
  ].filter(Boolean);
  const requested = !nonExecution && !interactive
    && (managedCommand || reasons.some((reason) => !["non_execution_intent", "interactive_process_excluded"].includes(reason)));
  const taskSupervisor = requested && availableNames.has("start_job");
  if (requested && !taskSupervisor) reasons.push("start_job_unavailable");
  return {
    task_supervisor: taskSupervisor,
    preferred_surface: taskSupervisor ? "start_job" : null,
    continuation_mode: taskSupervisor ? "task_supervisor" : null,
    job_shape: taskSupervisor ? "single_umbrella" : null,
    continue_same_response: taskSupervisor && terminalResultRequiredIntent(task, options),
    stop_conditions: stopConditions(),
    reasons: unique(reasons),
  };
}

function stopConditions() {
  return ["actual_host_or_tool_boundary", "external_input_or_authorization_required", "explicit_user_checkpoint"];
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}
const OPERATIONAL_STATES = new Set(["ready", "starting", "running"]);

export class LifecycleController {
  constructor(name = "runtime", now = Date.now) {
    this.name = String(name || "runtime");
    this.now = typeof now === "function" ? now : Date.now;
    this.state = "ready";
    this.changedAt = this.now();
    this.failureCode = "";
  }

  beginStart() {
    if (this.state === "running") return false;
    if (this.state !== "ready" && this.state !== "failed") {
      throw new BridgeError("conflict", `${this.name} cannot start from state ${this.state}`);
    }
    this.transition("starting");
    return true;
  }

  markRunning() {
    if (this.state !== "starting") throw new BridgeError("conflict", `${this.name} cannot become running from state ${this.state}`);
    this.failureCode = "";
    this.transition("running");
  }

  markFailed(error) {
    this.failureCode = String(error?.code || error?.name || "execution_failed").slice(0, 64);
    this.transition("failed");
  }

  markStopFailed(error) {
    if (this.state !== "stopping") throw new BridgeError("conflict", `${this.name} cannot fail stop from state ${this.state}`);
    this.failureCode = String(error?.code || error?.name || "execution_failed").slice(0, 64);
    this.transition("stop_failed");
  }

  beginStop() {
    if (this.state === "stopped" || this.state === "stopping") return false;
    this.transition("stopping");
    return true;
  }

  markStopped() {
    if (this.state !== "stopping") throw new BridgeError("conflict", `${this.name} cannot become stopped from state ${this.state}`);
    this.transition("stopped");
  }

  assertOperational() {
    if (!OPERATIONAL_STATES.has(this.state)) {
      throw new BridgeError("unavailable", `${this.name} is not operational (${this.state})`, { retryable: this.state !== "stopped" });
    }
  }

  snapshot() {
    return {
      state: this.state,
      operational: OPERATIONAL_STATES.has(this.state),
      changed_at_ms: this.changedAt,
      failure_code: this.failureCode,
    };
  }

  transition(next) {
    this.state = next;
    this.changedAt = this.now();
  }
}
