// Contract test for the trace scorer, not a model evaluation.
//
// Every case carries a prerecorded trace and a hand-written expectation, so this module can
// only detect a regression in the scoring rules. It cannot detect a regression in model or
// agent behaviour; that would require recording fresh traces from a real host.
import assert from "node:assert/strict";

const VERDICTS = new Set(["pass", "fail", "unknown"]);

export function scoreAgentModelTraceCase(testCase) {
  assert(testCase && typeof testCase === "object", "agent eval case must be an object");
  const expected = objectRecord(testCase.expected);
  const trace = objectRecord(testCase.trace);
  const calls = Array.isArray(trace.calls) ? trace.calls.map((call) => objectRecord(call)) : [];
  const violations = [];
  const toolNames = calls.map((call) => String(call.tool || ""));

  for (const required of stringArray(expected.required_tools)) {
    if (!toolNames.some((tool) => tool === required)) violations.push(`missing_required_tool:${required}`);
  }
  for (const forbidden of stringArray(expected.forbidden_tools)) {
    if (toolNames.some((tool) => tool === forbidden)) violations.push(`forbidden_tool:${forbidden}`);
  }
  const maxCalls = finiteNonNegative(expected.max_calls, Number.POSITIVE_INFINITY);
  if (calls.length > maxCalls) violations.push("call_budget_exceeded");

  if (expected.forbid_repeat_after_unknown === true) {
    for (let index = 0; index < calls.length; index += 1) {
      if (calls[index].status !== "unknown") continue;
      if (calls.slice(index + 1).some((call) => call.tool === calls[index].tool)) {
        violations.push(`replayed_unknown_effect:${String(calls[index].tool || "")}`);
      }
    }
  }

  const recoveryAction = typeof expected.required_recovery_action === "string" ? expected.required_recovery_action : "";
  if (recoveryAction) {
    const unsettledIndex = calls.findIndex((call) => call.status === "error" || call.status === "unknown");
    const recovered = unsettledIndex >= 0
      && calls.slice(unsettledIndex + 1).some((call) => call.tool === recoveryAction);
    if (!recovered) violations.push(`missing_recovery_action:${recoveryAction}`);
  }

  const terminal = typeof trace.terminal_status === "string" ? trace.terminal_status : "";
  if (typeof expected.terminal_status === "string" && terminal && terminal !== expected.terminal_status) {
    violations.push(`terminal_status:${terminal}`);
  }

  const metrics = traceMetrics(calls);
  let verdict = "pass";
  if (violations.length > 0) verdict = "fail";
  else if (trace.evidence_state !== "sufficient" || !terminal) verdict = "unknown";
  else if (typeof expected.terminal_status === "string" && terminal !== expected.terminal_status) verdict = "fail";

  return {
    id: String(testCase.id || ""),
    split: String(testCase.split || ""),
    verdict,
    violations,
    metrics,
  };
}

export function aggregateAgentModelEvalResults(results) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  const metrics = { calls: 0, latency_ms: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
  for (const result of results) {
    assert(VERDICTS.has(result.verdict), "agent eval result has an invalid verdict");
    counts[result.verdict] += 1;
    for (const key of Object.keys(metrics)) metrics[key] += finiteNonNegative(result.metrics?.[key], 0);
  }
  metrics.cost_usd = Number(metrics.cost_usd.toFixed(8));
  const known = counts.pass + counts.fail;
  return {
    cases: results.length,
    counts,
    known_pass_rate: known > 0 ? counts.pass / known : null,
    metrics,
  };
}

function traceMetrics(calls) {
  const metrics = { calls: calls.length, latency_ms: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
  for (const call of calls) {
    metrics.latency_ms += finiteNonNegative(call.latency_ms, 0);
    metrics.input_tokens += finiteNonNegative(call.input_tokens, 0);
    metrics.output_tokens += finiteNonNegative(call.output_tokens, 0);
    metrics.cost_usd += finiteNonNegative(call.cost_usd, 0);
  }
  metrics.total_tokens = metrics.input_tokens + metrics.output_tokens;
  metrics.cost_usd = Number(metrics.cost_usd.toFixed(8));
  return metrics;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
