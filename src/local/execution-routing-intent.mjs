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
