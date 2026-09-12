import { performance } from "node:perf_hooks";

const DEFAULT_WORKFLOW_POLL_INTERVAL_MS = 15_000;
const DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export function requireSuccessfulWorkflowRun(runs, head, workflowName = "CI") {
  const run = latestPushWorkflowRun(runs, head, workflowName);
  if (run.status !== "completed") {
    throw new Error(`${workflowName} run ${run.databaseId || "unknown"} for release commit ${head} is ${run.status || "unknown"}; wait for completion and retry`);
  }
  if (run.conclusion !== "success") {
    throw new Error(`${workflowName} run ${run.databaseId || "unknown"} for release commit ${head} concluded ${run.conclusion || "unknown"}; fix or rerun the workflow before release`);
  }
  return run;
}

export async function waitForSuccessfulWorkflowRun(loadRuns, head, workflowName = "CI", options = {}) {
  if (typeof loadRuns !== "function") throw new Error("GitHub Actions run loader must be a function");
  validateReleaseHead(head);
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const wait = typeof options.wait === "function" ? options.wait : defaultWorkflowWait;
  const pollIntervalMs = positiveFinite(options.pollIntervalMs, DEFAULT_WORKFLOW_POLL_INTERVAL_MS, "workflow poll interval");
  const deadlineMs = options.deadlineMs === undefined
    ? now() + DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS
    : finiteDeadline(options.deadlineMs);
  let observed = null;
  for (;;) {
    if (now() >= deadlineMs) throw workflowWaitTimeout(workflowName, head, observed);
    const runs = await loadRuns();
    let run = null;
    try {
      run = latestPushWorkflowRun(runs, head, workflowName);
    } catch (error) {
      if (!isMissingWorkflowRun(error, workflowName, head)) throw error;
    }
    if (run) {
      observed = run;
      if (run.status === "completed") {
        if (run.conclusion !== "success") {
          throw new Error(`${workflowName} run ${run.databaseId || "unknown"} for release commit ${head} concluded ${run.conclusion || "unknown"}; fix or rerun the workflow before release`);
        }
        return run;
      }
    } else {
      observed = null;
    }
    const remainingMs = deadlineMs - now();
    if (!(remainingMs > 0)) throw workflowWaitTimeout(workflowName, head, observed);
    await wait(Math.min(pollIntervalMs, remainingMs));
  }
}

export function requireSuccessfulCiRun(runs, head) {
  return requireSuccessfulWorkflowRun(runs, head, "CI");
}

function latestPushWorkflowRun(runs, head, workflowName) {
  if (!Array.isArray(runs)) throw new Error("GitHub Actions response is not an array");
  validateReleaseHead(head);
  const label = String(workflowName || "workflow");
  const matching = runs
    .filter((run) => run && run.headSha === head && run.event === "push")
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const run = matching[0];
  if (!run) {
    throw new Error(`no push-triggered ${label} run exists for release commit ${head}; wait for GitHub Actions to register the run and retry`);
  }
  return run;
}

function validateReleaseHead(head) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(head || ""))) throw new Error("release commit SHA is invalid");
}

function positiveFinite(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive finite number`);
  return number;
}

function finiteDeadline(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("workflow wait deadline must be finite");
  return number;
}

function isMissingWorkflowRun(error, workflowName, head) {
  return String(error?.message || error).startsWith(`no push-triggered ${String(workflowName || "workflow")} run exists for release commit ${head};`);
}

function workflowWaitTimeout(workflowName, head, run) {
  const label = String(workflowName || "workflow");
  const state = run
    ? `latest run ${run.databaseId || "unknown"} remained ${run.status || "unknown"}`
    : "no exact-commit push run was registered";
  return new Error(`${label} did not succeed for release commit ${head} before the finite CI wait deadline; ${state}`);
}

function defaultWorkflowWait(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}
