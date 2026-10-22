import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRuntime } from "../src/local/runtime.mjs";
import { healthyResourceHost } from "./fixtures/healthy-resource-host.mjs";
import { managedJobRecentActivity, managedJobRecoveryPriority, recentProcessRecoveryJobs } from "../src/local/managed-job-listing.mjs";
import { classifyEffectStatus } from "../src/local/computer-use-verification.mjs";
import { spawnManagedJobTestRunnerWithoutCoverage } from "./fixtures/managed-jobs/common.mjs";

const root = await realpath(await mkdtemp(join(tmpdir(), "mbm-agent-workflow-")));
const workspace = join(root, "workspace");
await mkdir(join(workspace, ".project-local"), { recursive: true });
const options = { workspace, policy: { profile: "full", origin: "explicit", revision: 3 }, jobRoot: join(root, "jobs"),
  resourceCoordinatorRoot: join(root, "resource-coordinator"), resourceCoordinatorOptions: { sampleHost: healthyResourceHost },
  agentHome: join(root, "empty-home"), codexHome: join(root, "empty-codex"), recoverJobs: false, processResourceWaitMs: 10000 };
let runtime = new LocalRuntime(options);
runtime.managedJobManager.runnerSpawnProcess = spawnManagedJobTestRunnerWithoutCoverage;
try {
  // Final-state oracle for an agent discovering context, reading, editing and reconciling a conflict.
  await writeFile(join(workspace, "AGENTS.md"), "Preserve Python indentation and inspect conflicts.");
  await writeFile(join(workspace, ".project-local", "agent-memory.json"), JSON.stringify({ version: 1, notes: [{ text: "broken", timestamp: 1e300 }] }));
  await writeFile(join(workspace, "module.py"), "if ready:\n    execute()\n");
  const context = await runtime.executeTool("agent_context", {});
  assert(context.effective_instructions.includes("Preserve Python indentation"));
  assert.equal(context.persistent_memory.status, "invalid");
  const original = await runtime.executeTool("read_file", { path: "module.py" });
  await runtime.executeTool("edit_file", { path: "module.py", old_text: "    execute()", new_text: "    execute_again()", expected_sha256: original.sha256 });
  await assert.rejects(runtime.executeTool("edit_file", { path: "module.py", old_text: "execute_again()", new_text: "wrong()", expected_sha256: original.sha256 }), (error) => error.details?.reason === "hash_mismatch");
  assert.equal(await readFile(join(workspace, "module.py"), "utf8"), "if ready:\n    execute_again()\n");

  // A durable accepted operation survives caller replacement and is recovered without a second effect.
  const counter = join(workspace, "counter.txt"); await writeFile(counter, "0");
  const jobArgs = { idempotency_key: "agent-workflow-counter-once", steps: [{ argv: [process.execPath, "-e",
    "setTimeout(()=>{const f=require('node:fs'),p=process.argv[1];f.writeFileSync(p,String(Number(f.readFileSync(p,'utf8'))+1));},300)", counter], timeout_seconds: 10 }] };
  const accepted = await runtime.executeTool("start_job", jobArgs);
  assert(accepted.job_id);
  await runtime.stop(); runtime = new LocalRuntime(options);
  runtime.managedJobManager.runnerSpawnProcess = spawnManagedJobTestRunnerWithoutCoverage;
  const recovered = await runtime.executeTool("start_job", jobArgs);
  assert.equal(recovered.job_id, accepted.job_id);
  const deadline = Date.now() + 15000;
  let status;
  do {
    status = await runtime.executeTool("read_job", { job_id: accepted.job_id, wait_ms: 100 });
    if (status.status === "succeeded") break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(status.status, "succeeded");
  assert.equal(await readFile(counter, "utf8"), "1", "recovery repeated the business side effect");

  const now = Date.now();
  const records = [
    { job: { job_id: "visible", status: "succeeded", created_at: new Date(now).toISOString(), finished_at: new Date(now).toISOString() }, retentionClass: "durable" },
    ...Array.from({ length: 20 }, (_, i) => ({ job: { job_id: `recovery-${i}`, status: "succeeded", created_at: new Date(now).toISOString(), finished_at: new Date(now - 1000).toISOString() }, retentionClass: "transient_process", recoveryPending: i === 19 })),
  ];
  const recovery = recentProcessRecoveryJobs(records, [records[0].job], now);
  assert.equal(recovery.length, 16); assert.equal(recovery[0].job_id, "recovery-19");
  assert(!recovery.some((job) => job.job_id === "visible"));
  assert(managedJobRecoveryPriority({ status: "running" }, "durable") < managedJobRecoveryPriority({ status: "succeeded" }, "durable"));
  assert.equal(managedJobRecentActivity(records, now).terminal_last_15m, 21);

  // Effect classification remains conservative when post-action evidence is incomplete.
  for (const dispatchStatus of ["confirmed", "unknown", "not_started"]) {
    assert.equal(classifyEffectStatus({ dispatchStatus, expectation: {}, verificationProbe: { inconclusive: true }, postCapture: {} }), "unknown");
    assert.equal(classifyEffectStatus({ dispatchStatus, expectation: null, verificationProbe: {}, postCapture: {} }), "unknown");
  }
  console.log("agent workflows passed: conflict final state, invalid memory, durable recovery and unsettled effects");
} finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
