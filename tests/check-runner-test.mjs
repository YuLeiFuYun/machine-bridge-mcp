import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "../src/local/npm-cli.mjs";
import { runVerificationPlan } from "../scripts/check-runner.mjs";
import { assertHostCapabilities } from "../scripts/verification-capabilities.mjs";
import { verificationChildEnvironment } from "../scripts/verification-environment.mjs";
import {
  rerunVerificationUnderIdleSleepGuard,
  VERIFICATION_IDLE_SLEEP_GUARD_ENV,
} from "../scripts/verification-idle-sleep-guard.mjs";
import { runWithStableGeneration } from "../scripts/verification-generation-guard.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-check-runner-test-"));
try {
  const runChecksEntry = fileURLToPath(new URL("../scripts/run-checks.mjs", import.meta.url));
  const privateMode = `ghp_${"R".repeat(36)}`;
  const topLevelFailure = spawnSync(process.execPath, [runChecksEntry, privateMode], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, [VERIFICATION_IDLE_SLEEP_GUARD_ENV]: "1" },
  });
  assert.notEqual(topLevelFailure.status, 0, "run-checks accepted an invalid private check mode");
  assert(!String(topLevelFailure.stderr).includes(privateMode)
    && String(topLevelFailure.stderr).includes("<redacted-access-token>"),
  "run-checks top-level failure reflected credential-shaped input");

  const isolatedEnvironment = verificationChildEnvironment({
    MBM_RELAY_PROXY: "http://127.0.0.1:17891",
    MBM_RELAY_FALLBACK_PROXY: "",
    mbm_relay_proxy: "http://127.0.0.1:17892",
    MbM_ReLaY_PrOxY: "http://127.0.0.1:17893",
    MBM_DEBUG: "1",
    MBM_MACOS_BACKGROUND_VISUAL_BACKEND: "skylight-experimental",
    MBM_MACOS_TRUST_BROKER: "/Applications/Example Trust Broker.app/Contents/MacOS/example-trust-broker",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
    CHECK_RUNNER_PRESERVED: "yes",
  });
  assert.equal(Object.keys(isolatedEnvironment).some((key) => key.toUpperCase() === "MBM_RELAY_PROXY"), false,
    "verification child environment retained a case-variant daemon-only relay proxy route");
  assert.equal(Object.keys(isolatedEnvironment).some((key) => key.toUpperCase() === "MBM_RELAY_FALLBACK_PROXY"), false,
    "verification child environment retained the daemon-only relay fallback proxy route");
  for (const key of ["MBM_DEBUG", "MBM_MACOS_BACKGROUND_VISUAL_BACKEND", "MBM_MACOS_TRUST_BROKER"]) {
    assert.equal(isolatedEnvironment[key], undefined,
      `verification child environment retained owner runtime configuration: ${key}`);
  }
  assert.equal(isolatedEnvironment.HTTPS_PROXY, "http://proxy.example.invalid:8080",
    "verification child environment removed the ordinary HTTPS proxy route");
  assert.equal(isolatedEnvironment.CHECK_RUNNER_PRESERVED, "yes",
    "verification child environment removed an unrelated value");

  // npm --silent suppresses failures before a lifecycle script can start.
  const malformedManifest = join(root, "package.json");
  await writeFile(malformedManifest, "{broken", "utf8");
  const manifestError = sink();
  try {
    await assert.rejects(() => runVerificationPlan({
      mode: "npm-configuration-failure",
      tasks: ["must-not-start"],
      npmCli: resolveNpmCli(),
      cwd: root,
      stdout: sink(),
      stderr: manifestError,
    }), /verification task failed/);
    // The contract is "a causal configuration diagnostic survives npm --silent", not
    // "npm's private error code appears verbatim": Node 26 aborts on a malformed nearest
    // package.json with ERR_INVALID_PACKAGE_CONFIG before npm ever starts.
    assert(manifestError.value.includes("package.json")
      && /EJSONPARSE|ERR_INVALID_PACKAGE_CONFIG|Invalid package config|Unexpected token/i.test(manifestError.value),
    "nested npm configuration failure lost its causal diagnostic");
  } finally { await rm(malformedManifest); }

  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
const task = process.argv.at(-1);
const nl = String.fromCharCode(10);
const privatePath = ["", "Users", "private-runner", "secret.txt"].join("/");
if (task === "noisy-success") {
  process.stdout.write("S".repeat(200000));
  process.stderr.write("W".repeat(200000));
  process.exitCode = 0;
} else if (task === "explicit-skip") {
  process.stdout.write("MBM_TEST_SKIP: host lacks /proc" + nl);
  process.exitCode = 0;
} else if (task === "self-test") {
  process.stdout.write("hidden self-test chatter" + nl);
  process.stdout.write("local self-test phase started: resource CLI" + nl);
  process.stdout.write("more hidden self-test chatter" + nl);
  process.stdout.write("local self-test phase completed: resource CLI" + nl);
  process.exitCode = 0;
} else if (task === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("BEGIN-STDOUT" + nl + "O".repeat(200000) + nl + "END-STDOUT" + nl);
  process.stderr.write("BEGIN-STDERR" + nl + privatePath + nl + "E".repeat(200000) + nl + "END-STDERR" + nl);
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

  const skipOut = sink();
  const skipResult = await runVerificationPlan({
    mode: "test",
    tasks: ["explicit-skip"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: skipOut,
    stderr: sink(),
  });
  assert.match(skipOut.value, /skipped explicit-skip: host lacks \/proc/,
    "an explicitly requested verification skip was not surfaced");
  assert.doesNotMatch(skipOut.value, /completed explicit-skip/,
    "an explicitly requested verification skip was reported as a completed task");
  assert.match(skipOut.value, /test verification plan passed in .*\(0 passed, 1 skipped\)/,
    "the plan summary did not distinguish a skipped task from a passing one");
  assert.deepEqual(skipResult?.skipped, [{ task: "explicit-skip", reason: "host lacks /proc" }],
    "the plan did not return its skipped tasks to the caller that persists evidence");

  const timeoutOut = sink();
  const timeoutErr = sink();
  await assert.rejects(() => runVerificationPlan({
    mode: "test",
    tasks: ["hang"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: timeoutOut,
    stderr: timeoutErr,
    taskTimeouts: new Map([["hang", 250]]),
  }), /timed out/, "a hung verification task did not hit the per-task timeout");
  assert(timeoutOut.value.match(/completed hang/) === null, "a timed-out task was reported as completed");

  const progressOut = sink();
  await runVerificationPlan({
    mode: "test",
    tasks: ["self-test"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: progressOut,
    stderr: sink(),
  });
  assert(progressOut.value.includes("local self-test phase started: resource CLI")
    && progressOut.value.includes("local self-test phase completed: resource CLI"),
  "self-test sparse phase progress was not forwarded while the child was active");
  assert(!progressOut.value.includes("hidden self-test chatter") && !progressOut.value.includes("more hidden"),
    "sparse self-test progress forwarding leaked ordinary child output");

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
  assert(!failureErr.value.includes("private-runner") && failureErr.value.includes("<home>/secret.txt"),
    "failure diagnostics exposed a private home path from child output");
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
    env: {
      MBM_RELAY_PROXY: "http://127.0.0.1:17891",
      MBM_RELAY_FALLBACK_PROXY: "",
      CHECK_RUNNER_PRESERVED: "yes",
      NODE_V8_COVERAGE: join(root, "shared-coverage"),
      MBM_CHECK_FULL_COVERAGE_CONTEXT: join(root, "shared-coverage", ".mbm-full-coverage-context.json"),
    },
    spawnProcess: direct.spawn,
  });
  await turn();
  assert.equal(direct.invocations[0].executable, process.execPath, "simple Node package script did not bypass nested npm");
  assert.deepEqual(direct.invocations[0].args, ["tests/direct-test.mjs", "--check"], "direct Node package script arguments drifted");
  assert.equal(direct.invocations[0].options.env.npm_lifecycle_event, "direct-test", "direct Node execution lost npm lifecycle identity");
  assert.equal(direct.invocations[0].options.env.MBM_RELAY_PROXY, undefined,
    "direct Node verification inherited the owner daemon's relay-only proxy route");
  assert.equal(direct.invocations[0].options.env.MBM_RELAY_FALLBACK_PROXY, undefined,
    "direct Node verification inherited the owner daemon's relay fallback proxy route");
  assert.equal(direct.invocations[0].options.env.CHECK_RUNNER_PRESERVED, "yes",
    "verification environment isolation removed an unrelated environment value");
  assert.equal(direct.invocations[0].options.env.NODE_V8_COVERAGE, join(root, "shared-coverage"),
    "direct verification dropped the full-plan V8 coverage directory");
  assert.equal(direct.invocations[0].options.env.MBM_CHECK_FULL_COVERAGE_CONTEXT, join(root, "shared-coverage", ".mbm-full-coverage-context.json"),
    "direct verification dropped the full-plan coverage context");
  direct.finish("direct-test", 0);
  await turn();
  assert(direct.invocations[1].args.includes(fakeNpm) && direct.invocations[1].args.at(-1) === "hooked-test", "package script with lifecycle hooks bypassed npm");
  assert.equal(direct.invocations[1].options.env.MBM_RELAY_PROXY, undefined,
    "nested npm verification inherited the owner daemon's relay-only proxy route");
  assert.equal(direct.invocations[1].options.env.MBM_RELAY_FALLBACK_PROXY, undefined,
    "nested npm verification inherited the owner daemon's relay fallback proxy route");
  assert.equal(direct.invocations[1].options.env.CHECK_RUNNER_PRESERVED, "yes",
    "nested npm verification lost an unrelated environment value");
  assert.equal(direct.invocations[1].options.env.NODE_V8_COVERAGE, join(root, "shared-coverage"),
    "nested npm verification dropped the full-plan V8 coverage directory");
  assert.equal(direct.invocations[1].options.env.MBM_CHECK_FULL_COVERAGE_CONTEXT, join(root, "shared-coverage", ".mbm-full-coverage-context.json"),
    "nested npm verification dropped the full-plan coverage context");
  direct.finish("hooked-test", 0);
  await turn();
  assert(direct.invocations[2].args.includes(fakeNpm) && direct.invocations[2].args.at(-1) === "compound-test", "compound package script bypassed npm shell semantics");
  direct.finish("compound-test", 0);
  await directRun;

  const scoped = controlledSpawn();
  const coverageDirectory = join(root, "curated-coverage");
  const coverageContext = join(coverageDirectory, ".mbm-full-coverage-context.json");
  const scopedRun = runVerificationPlan({
    mode: "task-environment-test",
    tasks: ["coverage-fixture", "unrelated-test", "coverage:test"],
    npmCli: fakeNpm,
    cwd: root,
    stdout: sink(),
    stderr: sink(),
    packageScripts: {
      "coverage-fixture": "node tests/policy-test.mjs",
      "unrelated-test": "node tests/unrelated-test.mjs",
      "coverage:test": "node scripts/coverage-check.mjs",
    },
    env: { CHECK_RUNNER_PRESERVED: "yes" },
    taskEnvironments: new Map([
      ["coverage-fixture", { NODE_V8_COVERAGE: coverageDirectory }],
      ["coverage:test", { NODE_V8_COVERAGE: coverageDirectory, MBM_CHECK_FULL_COVERAGE_CONTEXT: coverageContext }],
    ]),
    spawnProcess: scoped.spawn,
  });
  await turn();
  assert.equal(scoped.invocations[0].options.env.NODE_V8_COVERAGE, coverageDirectory,
    "curated coverage task did not receive its task-scoped V8 directory");
  assert.equal(scoped.invocations[0].options.env.MBM_CHECK_FULL_COVERAGE_CONTEXT, undefined,
    "ordinary curated fixture received the private reuse context reserved for coverage:test");
  scoped.finish("coverage-fixture", 0);
  await turn();
  assert.equal(scoped.invocations[1].options.env.NODE_V8_COVERAGE, undefined,
    "unrelated verification task was allowed to contaminate curated coverage evidence");
  assert.equal(scoped.invocations[1].options.env.MBM_CHECK_FULL_COVERAGE_CONTEXT, undefined,
    "unrelated verification task received the private full-coverage context");
  scoped.finish("unrelated-test", 0);
  await turn();
  assert.equal(scoped.invocations[2].options.env.NODE_V8_COVERAGE, coverageDirectory,
    "coverage gate did not receive the shared V8 directory");
  assert.equal(scoped.invocations[2].options.env.MBM_CHECK_FULL_COVERAGE_CONTEXT, coverageContext,
    "coverage gate did not receive the parent-bound reuse context");
  scoped.finish("coverage:test", 0);
  await scopedRun;

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

  await assert.rejects(() => runWithStableGeneration({ run: async () => 42 }), /captureGeneration must be a function/);
  await assert.rejects(() => runWithStableGeneration({ captureGeneration: () => "stable" }), /run must be a function/);
  let generation = "stable";
  assert.equal(await runWithStableGeneration({
    captureGeneration: () => generation,
    run: async () => 42,
  }), 42, "stable verification generation lost a successful result");
  const stableFailure = new Error("stable task failed");
  await assert.rejects(() => runWithStableGeneration({
    captureGeneration: () => generation,
    run: async () => { throw stableFailure; },
  }), (error) => error === stableFailure, "stable verification generation replaced the task failure");
  generation = "before";
  await assert.rejects(() => runWithStableGeneration({
    label: "test inputs",
    captureGeneration: () => generation,
    run: async () => { generation = "after"; },
  }), /test inputs changed during verification; discard this run/);
  generation = "before-failure";
  const invalidatedFailure = new Error("must be discarded");
  await assert.rejects(() => runWithStableGeneration({
    captureGeneration: () => generation,
    run: async () => { generation = "after-failure"; throw invalidatedFailure; },
  }), (error) => error !== invalidatedFailure && /changed during verification; discard this run/.test(error.message),
  "generation drift did not supersede a result produced from mixed verification inputs");

  await assert.rejects(() => runVerificationPlan({
    mode: "invalid-concurrency",
    tasks: [],
    npmCli: fakeNpm,
    cwd: root,
    concurrency: 0,
  }), /verification concurrency/);

  const awake = controlledGuardSpawn();
  const awakeRun = rerunVerificationUnderIdleSleepGuard({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    execPath: "/test/node",
    argv: ["/repo/scripts/run-checks.mjs", "fast"],
    spawnProcess: awake.spawn,
  });
  await turn();
  assert.equal(awake.invocations.length, 1, "macOS verification did not establish exactly one idle-sleep guard");
  assert.equal(awake.invocations[0].executable, "/usr/bin/caffeinate", "macOS verification used an unexpected wake-lock executable");
  assert.deepEqual(awake.invocations[0].args, ["-i", "/test/node", "/repo/scripts/run-checks.mjs", "fast"],
    "macOS verification idle-sleep guard did not wrap the exact Node entrypoint argv");
  assert.equal(awake.invocations[0].options.env[VERIFICATION_IDLE_SLEEP_GUARD_ENV], "1",
    "macOS verification idle-sleep guard did not prevent recursive wrapping");
  assert.equal(awake.invocations[0].options.shell, false, "verification idle-sleep guard regained shell interpretation");
  awake.child.emit("close", 0, null);
  assert.equal(await awakeRun, 0, "verification idle-sleep guard lost the wrapped check exit status");

  const alreadyGuarded = controlledGuardSpawn();
  assert.equal(await rerunVerificationUnderIdleSleepGuard({
    platform: "darwin",
    env: { [VERIFICATION_IDLE_SLEEP_GUARD_ENV]: "1" },
    execPath: "/test/node",
    argv: ["/repo/scripts/run-checks.mjs", "full"],
    spawnProcess: alreadyGuarded.spawn,
  }), null, "already-guarded verification recursively invoked caffeinate");
  assert.equal(alreadyGuarded.invocations.length, 0, "already-guarded verification spawned a second idle-sleep guard");

  const nonDarwin = controlledGuardSpawn();
  assert.equal(await rerunVerificationUnderIdleSleepGuard({
    platform: "linux",
    env: {},
    execPath: "/test/node",
    argv: ["/repo/scripts/run-checks.mjs", "fast"],
    spawnProcess: nonDarwin.spawn,
  }), null, "non-macOS verification gained a platform-specific wake-lock dependency");
  assert.equal(nonDarwin.invocations.length, 0, "non-macOS verification spawned caffeinate");

  await assert.rejects(
    () => rerunVerificationUnderIdleSleepGuard({
      platform: "darwin",
      env: {},
      execPath: "/test/node",
      argv: ["/repo/scripts/run-checks.mjs", "fast"],
      spawnProcess() { throw new Error("missing caffeinate"); },
    }),
    /could not start the macOS verification idle-sleep guard/,
    "verification silently continued after failing to establish its macOS idle-sleep guard",
  );

  // Capability preflight: a host that cannot provide a process start time must fail in
  // one probe instead of after the rest of the plan has already run.
  assert.doesNotThrow(() => assertHostCapabilities(["privacy:check"], { platform: "linux", probe: () => null }),
    "capability preflight rejected a plan that never runs agent-workflows");
  assert.doesNotThrow(() => assertHostCapabilities(["agent-workflows:test"], { platform: "win32", probe: () => null }),
    "capability preflight rejected Windows, where the process-start-time probe is not required");
  assert.doesNotThrow(() => assertHostCapabilities(["agent-workflows:test"], { platform: "linux", env: { MBM_ALLOW_AGENT_WORKFLOW_SKIP: "1" }, probe: () => null }),
    "capability preflight ignored an explicit skip opt-in");
  assert.doesNotThrow(() => assertHostCapabilities(["agent-workflows:test"], { platform: "linux", env: {}, probe: () => 1 }),
    "capability preflight rejected a host that can provide a process start time");
  assert.throws(() => assertHostCapabilities(["agent-workflows:test"], { platform: "linux", env: {}, probe: () => null }),
    /requires a host process start time/,
    "capability preflight did not fail fast on a host without /proc or ps");
  assert.throws(() => assertHostCapabilities(["self-test"], { platform: "linux", env: {}, probe: () => null }),
    /self-test requires a host process start time/,
    "capability preflight let the self-test run into an unrecoverable durable-job failure");
  assert.throws(() => assertHostCapabilities(["agent-workflows:test", "self-test"], {
    platform: "linux", env: { MBM_ALLOW_AGENT_WORKFLOW_SKIP: "1" }, probe: () => null,
  }), /self-test requires a host process start time/,
  "the agent-workflows skip also excused the self-test's process-identity requirement");
  assert.doesNotThrow(() => assertHostCapabilities(["self-test"], { platform: "linux", env: {}, probe: () => 1 }),
    "capability preflight rejected a host that can provide a process start time");

  // A parent exits on TERM while its descendant ignores TERM and holds a TCP
  // port. Checking the port also avoids confusing a dead zombie with a leak.
  const fixture = join(root, "tree-fixture.mjs");
  await writeFile(fixture, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import net from "node:net";
    const [role, readyFile] = process.argv.slice(2);
    if (role === "descendant") {
      process.on("SIGTERM", () => {});
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => writeFileSync(readyFile, JSON.stringify({ pid: process.pid, port: server.address().port })));
      setTimeout(() => process.exit(0), 20000).unref();
    } else {
      spawn(process.execPath, [process.argv[1], "descendant", readyFile], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    }
  `);
  for (const cancelled of [false, true]) {
    const readyFile = join(root, cancelled ? "cancel-ready.json" : "timeout-ready.json");
    const controller = new AbortController();
    const run = runVerificationPlan({
      mode: "tree-regression", tasks: ["tree", "must-not-launch"], npmCli: fakeNpm,
      cwd: root, stdout: sink(), stderr: sink(), signal: controller.signal,
      packageScripts: { tree: `node tree-fixture.mjs parent ${cancelled ? "cancel-ready.json" : "timeout-ready.json"}` },
      taskTimeouts: { tree: 5000 },
    });
    // Register rejection handling immediately while waiting for child readiness.
    const outcome = run.then(() => null, (error) => error);
    let owned;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { owned = JSON.parse(await readFile(readyFile, "utf8")); break; } catch {}
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    }
    assert(owned, "process-tree regression fixture did not become ready");
    if (cancelled) controller.abort("SIGTERM");
    const error = await outcome;
    assert.equal(error?.exitCode, cancelled ? 143 : 124);
    // Signal delivery is asynchronous; allow a bounded scheduling turn after KILL.
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 100); });
    const listening = await new Promise((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port: owned.port });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => resolvePromise(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolvePromise(true); });
    });
    if (listening) { try { process.kill(owned.pid, "SIGKILL"); } catch {} }
    assert(!listening, "verification settled while a TERM-resistant descendant retained its port");
  }
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

function controlledGuardSpawn() {
  const child = new EventEmitter();
  const invocations = [];
  return {
    child,
    invocations,
    spawn(executable, args, options) {
      invocations.push({ executable, args, options });
      return child;
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
