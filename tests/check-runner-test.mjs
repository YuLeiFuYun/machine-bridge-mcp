import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerificationPlan } from "../scripts/check-runner.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-check-runner-test-"));
try {
  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
const task = process.argv.at(-1);
const nl = String.fromCharCode(10);
if (task === "noisy-success") {
  process.stdout.write("S".repeat(200000));
  process.stderr.write("W".repeat(200000));
  process.exitCode = 0;
} else {
  process.stdout.write("BEGIN-STDOUT" + nl + "O".repeat(200000) + nl + "END-STDOUT" + nl);
  process.stderr.write("BEGIN-STDERR" + nl + "E".repeat(200000) + nl + "END-STDERR" + nl);
  process.exitCode = 7;
}
`, "utf8");

  const successOut = sink();
  const successErr = sink();
  await runVerificationPlan({
    mode: "test",
    tasks: ["noisy-success"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: successOut,
    stderr: successErr,
  });
  assert(!successOut.value.includes("SSSS") && !successErr.value.includes("WWWW"), "successful task output was not suppressed");
  assert(successOut.value.includes("completed noisy-success"), "successful task progress was omitted");
  assert(successOut.value.length < 1024, "successful plan output remained too verbose");

  const failureOut = sink();
  const failureErr = sink();
  await assert.rejects(() => runVerificationPlan({
    mode: "test",
    tasks: ["noisy-failure"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: failureOut,
    stderr: failureErr,
  }), /verification task failed/);
  assert(failureErr.value.includes("BEGIN-STDOUT") && failureErr.value.includes("END-STDOUT"), "failure stdout did not preserve diagnostic head and tail");
  assert(failureErr.value.includes("BEGIN-STDERR") && failureErr.value.includes("END-STDERR"), "failure stderr did not preserve diagnostic head and tail");
  assert(failureErr.value.includes("[truncated "), "failure output did not disclose omitted bytes");
  assert(Buffer.byteLength(failureErr.value) < 140 * 1024, "failure diagnostics exceeded the two-stream bound");

  const direct = controlledSpawn();
  const directOut = sink();
  const directRun = runVerificationPlan({
    mode: "direct-node-test",
    tasks: ["direct-test", "hooked-test", "compound-test"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: directOut,
    stderr: sink(),
    packageScripts: {
      "direct-test": "node tests/direct-test.mjs --check",
      "hooked-test": "node tests/hooked-test.mjs",
      "prehooked-test": "node tests/setup.mjs",
      "compound-test": "node tests/compound-test.mjs && node tests/second.mjs",
    },
    spawnProcess: direct.spawn,
  });
  await turn();
  assert.equal(direct.invocations[0].executable, process.execPath, "simple Node package script did not bypass nested npm");
  assert.deepEqual(direct.invocations[0].args, ["tests/direct-test.mjs", "--check"], "direct Node package script arguments drifted");
  assert.equal(direct.invocations[0].options.env.npm_lifecycle_event, "direct-test", "direct Node execution lost npm lifecycle identity");
  direct.finish("direct-test", 0);
  await turn();
  assert(direct.invocations[1].args.includes(fakeNpm) && direct.invocations[1].args.at(-1) === "hooked-test", "package script with lifecycle hooks bypassed npm");
  direct.finish("hooked-test", 0);
  await turn();
  assert(direct.invocations[2].args.includes(fakeNpm) && direct.invocations[2].args.at(-1) === "compound-test", "compound package script bypassed npm shell semantics");
  direct.finish("compound-test", 0);
  await directRun;

  const parallel = controlledSpawn();
  const parallelOut = sink();
  const parallelRun = runVerificationPlan({
    mode: "parallel-test",
    tasks: ["parallel-a", "parallel-b", "parallel-c"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: parallelOut,
    stderr: sink(),
    concurrency: 2,
    parallelTaskNames: new Set(["parallel-a", "parallel-b", "parallel-c"]),
    spawnProcess: parallel.spawn,
  });
  await turn();
  assert.deepEqual(parallel.launched, ["parallel-a", "parallel-b"], "parallel runner exceeded or failed to fill its initial concurrency bound");
  parallel.finish("parallel-a", 0);
  await turn();
  assert.deepEqual(parallel.launched, ["parallel-a", "parallel-b", "parallel-c"], "parallel runner did not refill an available worker slot");
  parallel.finish("parallel-b", 0);
  parallel.finish("parallel-c", 0);
  await parallelRun;
  assert(parallelOut.value.includes("completed parallel-a") && parallelOut.value.includes("completed parallel-c"), "parallel completion progress was omitted");

  const failFast = controlledSpawn();
  const failFastErr = sink();
  const failFastRun = runVerificationPlan({
    mode: "parallel-failure-test",
    tasks: ["failing", "in-flight", "must-not-start"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: sink(),
    stderr: failFastErr,
    concurrency: 2,
    parallelTaskNames: new Set(["failing", "in-flight", "must-not-start"]),
    spawnProcess: failFast.spawn,
  });
  await turn();
  failFast.finish("failing", 9);
  await turn();
  assert(!failFast.launched.includes("must-not-start"), "parallel runner scheduled new verification work after a failure");
  failFast.finish("in-flight", 0);
  await assert.rejects(() => failFastRun, /verification task failed/);
  assert(failFastErr.value.includes("failing"), "parallel failure diagnostics omitted the failing task");

  await assert.rejects(() => runVerificationPlan({
    mode: "invalid-concurrency",
    tasks: [],
    npmCli: fakeNpm,
    cwd: root,
    concurrency: 0,
  }), /verification concurrency/);

  console.log("bounded parallel check runner test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function controlledSpawn() {
  const launched = [];
  const invocations = [];
  const children = new Map();
  return {
    launched,
    invocations,
    spawn(executable, argv, options) {
      const task = argv[1] === "run" ? argv.at(-1) : (options?.env?.npm_lifecycle_event || argv.at(-1));
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      launched.push(task);
      invocations.push({ executable, args: argv, options });
      children.set(task, child);
      return child;
    },
    finish(task, code) {
      const child = children.get(task);
      assert(child, `missing controlled child for ${task}`);
      children.delete(task);
      child.emit("close", code);
    },
  };
}

function turn() {
  return new Promise((resolvePromise) => { setImmediate(resolvePromise); });
}

function sink() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}
