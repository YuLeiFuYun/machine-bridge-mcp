import assert from "node:assert/strict";
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

  console.log("bounded check runner test ok");
} finally {
  await rm(root, { recursive: true, force: true });
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
