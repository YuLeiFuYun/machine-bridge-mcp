import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { parseWorkerTypesArguments, runWranglerTypes } from "../scripts/generate-worker-types.mjs";
import { runWorkerDryRun, WRANGLER_DRY_RUN_COMPLETION_MARKER } from "../scripts/run-worker-dry-run.mjs";

const root = await mkdtemp(join(tmpdir(), "machine-bridge-wrangler-lifecycle-"));
const fixture = join(root, "wrangler-fixture.mjs");
const target = join(root, "worker-configuration.d.ts");
const seed = join(root, "worker-runtime-types-seed.b64");
const typesCompletionMarker = "Remember to rerun 'wrangler types' after you change your wrangler.jsonc file.";
const runtimeHeader = "// Runtime types generated with workerd@9.9.9 2026-07-11 alpha,beta";
const baselineRuntime = runtimePayload("interface RuntimeCache { baseline: true }\n");
const refreshedRuntime = runtimePayload("interface RuntimeCache { refreshed: true }\n");
const mismatchedRuntime = runtimePayload("interface RuntimeCache { mismatch: true }\n");

try {
  await writeFile(fixture, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.env.MBM_WRANGLER_FIXTURE_MODE;
const command = process.argv[2];
let marker = "";
if (command === "types" && process.argv[3]) marker = ${JSON.stringify(`${typesCompletionMarker}\n`)};
else if (command === "deploy" && process.argv[3] === "--dry-run") marker = ${JSON.stringify(`${WRANGLER_DRY_RUN_COMPLETION_MARKER}\n`)};
else process.exit(9);
if (command === "types") {
  const target = process.argv[3];
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  process.stdout.write("types-existing:" + (before ? "yes" : "no") + "\\n");
  process.stdout.write("types-pre-runtime-only:" + (before.startsWith(process.env.MBM_RUNTIME_HEADER + "\\n// Begin runtime types\\n") ? "yes" : "no") + "\\n");
}
if (mode === "fail") process.exit(7);
if (mode === "hang-before") setInterval(() => {}, 1000);
else {
  if (command === "types") {
    const runtime = mode === "mismatch" ? process.env.MBM_MISMATCH_RUNTIME : process.env.MBM_RUNTIME_PAYLOAD;
    writeFileSync(process.argv[3], "/* fixture project declarations */\\ninterface Env {}\\n" + runtime);
    process.stdout.write("types-target:" + process.argv[3] + "\\n");
  }
  process.stdout.write(marker);
  if (mode === "hang-after") setInterval(() => {}, 1000);
  else if (mode === "normal-cleanup-race") setTimeout(() => process.exit(0), 250);
}
`, "utf8");

  await writeSeed(seed, baselineRuntime);
  await rm(target, { force: true });
  const cleanTypes = capture();
  await runWranglerTypes(typesOptions("normal", cleanTypes));
  assert(cleanTypes.stdout.includes("types-existing:yes") && cleanTypes.stdout.includes("types-pre-runtime-only:yes"),
    "clean worker-types path did not seed the runtime cache before Wrangler dispatch");
  assert.equal(extractRuntime(await readFile(target, "utf8")), baselineRuntime,
    "clean worker-types path did not preserve the tracked runtime seed exactly");

  await writeFile(target, `/* warm project declarations */\n${baselineRuntime}`, { mode: 0o640 });
  const warmTypes = capture();
  await runWranglerTypes(typesOptions("normal", warmTypes));
  assert(warmTypes.stdout.includes("types-existing:yes") && warmTypes.stdout.includes("types-pre-runtime-only:no"),
    "warm worker-types path replaced a valid full cache before Wrangler could inspect it");
  assert.equal(extractRuntime(await readFile(target, "utf8")), baselineRuntime, "warm cache runtime drifted from the tracked seed");

  const normalTypes = capture();
  await runWranglerTypes(typesOptions("normal", normalTypes));
  assert(normalTypes.stdout.includes("types-target:worker-configuration.d.ts") && !normalTypes.stdout.includes(root),
    "Wrangler types received an absolute generated-file path that can leak the local workspace path into generated comments");
  assert(normalTypes.stdout.includes(typesCompletionMarker), "normal Wrangler types output was not forwarded");
  assert(!normalTypes.stderr.includes("did not exit"), "normal Wrangler types exit was misclassified as a cleanup hang");
  await assert.rejects(
    runWranglerTypes({ ...commandOptions("normal", capture()), targetPath: join(root, "..", "worker-types-outside.d.ts"), seedPath: seed, expectedRuntimeHeader: runtimeHeader }),
    /Wrangler types target must remain inside its working directory/,
  );

  const hangingTypes = capture();
  await runWranglerTypes(typesOptions("hang-after", hangingTypes));
  assert.equal(extractRuntime(await readFile(target, "utf8")), baselineRuntime, "completed-but-hanging Wrangler lost generated types");
  assert(hangingTypes.stderr.includes("wrangler types completed but did not exit"), "completed Wrangler types hang was not diagnosed or bounded");

  const priorTarget = Buffer.from("prior target bytes\n");
  await writeFile(target, priorTarget);
  await chmod(target, 0o640);
  const priorTargetMode = (await stat(target)).mode & 0o777;
  await writeFile(seed, "!!!!\n", "utf8");
  const malformedOutput = capture();
  await assert.rejects(runWranglerTypes(typesOptions("normal", malformedOutput)), /not canonical UTF-8 Base64/);
  assert.equal(malformedOutput.stdout, "", "malformed runtime seed reached Wrangler dispatch");
  await assertSnapshot(target, priorTarget, priorTargetMode, "malformed seed changed the prior target");

  await writeSeed(seed, runtimePayload("interface OldRuntime {}\n", "// Runtime types generated with workerd@1.0.0 2020-01-01 old"));
  const staleOutput = capture();
  await assert.rejects(runWranglerTypes(typesOptions("normal", staleOutput)), /stale or contains non-runtime/);
  assert.equal(staleOutput.stdout, "", "stale runtime seed reached Wrangler dispatch");
  await assertSnapshot(target, priorTarget, priorTargetMode, "stale seed changed the prior target");
  await writeSeed(seed, baselineRuntime);

  const mismatchOutput = capture();
  await assert.rejects(runWranglerTypes(typesOptions("mismatch", mismatchOutput)), /do not match the tracked runtime seed/);
  await assertSnapshot(target, priorTarget, priorTargetMode, "post-generation runtime mismatch did not restore the prior target");

  await rm(target, { force: true });
  const failedAbsent = capture();
  await assert.rejects(runWranglerTypes(typesOptions("fail", failedAbsent)), /exit code 7/);
  await assert.rejects(readFile(target), { code: "ENOENT" });

  await writeFile(target, priorTarget);
  await chmod(target, 0o640);
  const failedExisting = capture();
  await assert.rejects(runWranglerTypes(typesOptions("fail", failedExisting)), /exit code 7/);
  await assertSnapshot(target, priorTarget, priorTargetMode, "Wrangler failure did not restore a pre-existing target exactly");

  await rm(target, { force: true });
  const stalledAbsent = capture();
  await assert.rejects(runWranglerTypes(typesOptions("hang-before", stalledAbsent, { timeoutMs: 80 })), /wrangler types timed out after 80ms/);
  await assert.rejects(readFile(target), { code: "ENOENT" });

  await writeFile(target, priorTarget);
  await chmod(target, 0o640);
  const stalledExisting = capture();
  await assert.rejects(runWranglerTypes(typesOptions("hang-before", stalledExisting, { timeoutMs: 80 })), /wrangler types timed out after 80ms/);
  await assertSnapshot(target, priorTarget, priorTargetMode, "Wrangler timeout did not restore a pre-existing target exactly");

  const oldSeed = Buffer.from(await readFile(seed));
  await chmod(seed, 0o640);
  await writeFile(target, priorTarget);
  await chmod(target, 0o640);
  const refreshOutput = capture();
  await runWranglerTypes(typesOptions("normal", refreshOutput, { refreshRuntimeSeed: true, runtimePayload: refreshedRuntime }));
  assert(refreshOutput.stdout.includes("types-existing:no"), "refresh mode did not force a fresh Wrangler runtime generation");
  assert.equal(decodeSeed(await readFile(seed, "utf8")), refreshedRuntime, "refresh mode did not publish the completed runtime as the tracked seed");
  assert.equal(extractRuntime(await readFile(target, "utf8")), refreshedRuntime, "refresh mode target/runtime seed diverged");

  await writeFile(seed, oldSeed, { mode: 0o640 });
  await writeFile(target, priorTarget);
  await chmod(target, 0o640);
  const refreshSeedBefore = Buffer.from(await readFile(seed));
  const refreshSeedMode = (await stat(seed)).mode & 0o777;
  const refreshFailure = capture();
  await assert.rejects(runWranglerTypes(typesOptions("fail", refreshFailure, { refreshRuntimeSeed: true, runtimePayload: refreshedRuntime })), /exit code 7/);
  await assertSnapshot(target, priorTarget, priorTargetMode, "refresh failure did not restore the prior target");
  await assertSnapshot(seed, refreshSeedBefore, refreshSeedMode, "refresh failure did not restore the prior seed");

  assert.deepEqual(parseWorkerTypesArguments([]), { refreshRuntimeSeed: false });
  assert.deepEqual(parseWorkerTypesArguments(["--refresh-runtime-seed"]), { refreshRuntimeSeed: true });
  assert.throws(() => parseWorkerTypesArguments(["--unexpected"]), /unknown worker-types option/);

  const normalDryRun = capture();
  await runWorkerDryRun(commandOptions("normal", normalDryRun));
  assert(normalDryRun.stdout.includes(WRANGLER_DRY_RUN_COMPLETION_MARKER), "normal Wrangler dry-run output was not forwarded");
  assert(!normalDryRun.stderr.includes("did not exit"), "normal Wrangler dry-run exit was misclassified as a cleanup hang");

  const racedNormalDryRun = capture();
  const cleanupSignals = [];
  await runWorkerDryRun(commandOptions("normal-cleanup-race", racedNormalDryRun, {
    completionExitGraceMs: 20,
    terminationGraceMs: 500,
    killChild(child, signal) {
      cleanupSignals.push(signal);
      if (signal === "SIGTERM") return true;
      return child.kill(signal);
    },
  }));
  assert.deepEqual(cleanupSignals, ["SIGTERM"], "Wrangler cleanup-race fixture did not request cleanup after the completion grace");
  assert(!racedNormalDryRun.stderr.includes("did not exit"), "successful Wrangler dry-run exit lost to a raced cleanup request");

  const racedForceDryRun = capture();
  const forceRaceSignals = [];
  await runWorkerDryRun(commandOptions("normal-cleanup-race", racedForceDryRun, {
    completionExitGraceMs: 20,
    terminationGraceMs: 40,
    forceSettlementGraceMs: 500,
    killChild(_child, signal) {
      forceRaceSignals.push(signal);
      return signal === "SIGTERM";
    },
  }));
  assert.deepEqual(forceRaceSignals, ["SIGTERM", "SIGKILL"], "Wrangler force-cleanup race did not cross both cleanup request boundaries");
  assert(!racedForceDryRun.stderr.includes("did not exit"), "a false force-kill request result overrode the later observed zero exit");

  const hangingDryRun = capture();
  await runWorkerDryRun(commandOptions("hang-after", hangingDryRun));
  assert(hangingDryRun.stderr.includes("wrangler deploy --dry-run completed but did not exit", "completed Wrangler dry-run hang was not diagnosed or bounded"));

  await assert.rejects(runWorkerDryRun(commandOptions("fail", capture())), /exit code 7/);
  await assert.rejects(runWorkerDryRun(commandOptions("hang-before", capture(), { timeoutMs: 80 })), /wrangler deploy --dry-run timed out after 80ms/);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log("Wrangler command lifecycle test ok");

function typesOptions(mode, output, overrides = {}) {
  const runtime = overrides.runtimePayload || baselineRuntime;
  return {
    ...commandOptions(mode, output, overrides),
    targetPath: target,
    seedPath: seed,
    expectedRuntimeHeader: runtimeHeader,
    env: {
      ...process.env,
      MBM_WRANGLER_FIXTURE_MODE: mode,
      MBM_RUNTIME_HEADER: runtimeHeader,
      MBM_RUNTIME_PAYLOAD: runtime,
      MBM_MISMATCH_RUNTIME: mismatchedRuntime,
    },
  };
}

function commandOptions(mode, output, overrides = {}) {
  return {
    cwd: root,
    wranglerPath: fixture,
    env: { ...process.env, MBM_WRANGLER_FIXTURE_MODE: mode },
    stdout: { write: (value) => { output.stdout += String(value); } },
    stderr: { write: (value) => { output.stderr += String(value); } },
    timeoutMs: 2_000,
    completionExitGraceMs: 500,
    terminationGraceMs: 200,
    ...overrides,
  };
}

function runtimePayload(body, header = runtimeHeader) {
  return `${header}\n// Begin runtime types\n${body}`;
}

function encodeSeed(payload) {
  const compressed = brotliCompressSync(Buffer.from(payload), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  const compact = compressed.toString("base64");
  return `${compact.match(/.{1,76}/g).join("\n")}\n`;
}

async function writeSeed(path, payload) {
  await writeFile(path, encodeSeed(payload), { encoding: "utf8", mode: 0o644 });
}

function decodeSeed(text) {
  return brotliDecompressSync(Buffer.from(text.replace(/\n/g, ""), "base64")).toString("utf8");
}

function extractRuntime(text) {
  const marker = text.indexOf("// Begin runtime types\n");
  const header = text.match(/^\/\/ Runtime types generated with workerd@[^\r\n]+$/m)?.[0];
  assert(header && marker >= 0, "fixture output omitted runtime header/marker");
  return `${header}\n${text.slice(marker)}`;
}

async function assertSnapshot(path, bytes, mode, message) {
  assert.deepEqual(Buffer.from(await readFile(path)), Buffer.from(bytes), message);
  assert.equal((await stat(path)).mode & 0o777, mode, `${message} (mode)`);
}

function capture() {
  return { stdout: "", stderr: "" };
}
