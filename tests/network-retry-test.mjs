import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientNetworkFailure, networkCommandArgs, runNetworkCommand } from "../scripts/network-retry.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-network-retry-test-"));
try {
  const counter = join(root, "counter.txt");
  const transientScript = [
    "const fs=require('node:fs');",
    "const p=process.argv[1];",
    "let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0}catch{}",
    "n+=1;fs.writeFileSync(p,String(n));",
    "if(n<3){process.stderr.write('unexpected EOF\\n');process.exit(1)}",
    "process.stdout.write('ok')",
  ].join("");
  const retried = runNetworkCommand(process.execPath, ["-e", transientScript, counter], { attempts: 3, baseDelayMs: 1, retryMode: "safe" });
  assert(retried.status === 0 && retried.stdout === "ok" && retried.attempts === 3, "transient network command was not retried to success");
  assert(readFileSync(counter, "utf8") === "3", "transient retry count was incorrect");

  for (const stream of ["stdout", "stderr"]) {
    writeFileSync(counter, "0");
    const successfulScript = "const fs=require('node:fs');const p=process.argv[1];"
      + "fs.writeFileSync(p,String(Number(fs.readFileSync(p,'utf8'))+1));"
      + "process." + stream + ".write('HTTP 503 ECONNRESET unexpected EOF is application data');";
    const successful = runNetworkCommand(process.execPath, ["-e", successfulScript, counter], { attempts: 3, baseDelayMs: 0 });
    assert(successful.status === 0 && successful.attempts === 1, "successful output triggered a network retry");
    assert(readFileSync(counter, "utf8") === "1", "successful side effect executed more than once");
  }
  assert(!isTransientNetworkFailure({ status: 0, stdout: "HTTP 503", stderr: "ECONNRESET" }),
    "successful command was classified from output text");

  writeFileSync(counter, "0");
  const permanentScript = "require('node:fs').writeFileSync(process.argv[1],'1');process.stderr.write('permission denied\\n');process.exit(1)";
  const permanent = runNetworkCommand(process.execPath, ["-e", permanentScript, counter], { attempts: 3, baseDelayMs: 1 });
  assert(permanent.status === 1 && permanent.attempts === 1, "non-transient command was retried");
  assert(readFileSync(counter, "utf8") === "1", "non-transient command executed more than once");

  assert(isTransientNetworkFailure({ status: 1, stderr: "LibreSSL SSL_connect: SSL_ERROR_SYSCALL" }), "known SSL connection interruption was not classified as transient");
  assert(!isTransientNetworkFailure({ status: 1, stderr: "TLS certificate policy rejected" }), "generic TLS policy failure was incorrectly classified as transient");

  for (const git of ["git", "/usr/bin/git", "/opt/homebrew/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe"]) {
    const gitArgs = networkCommandArgs(git, ["fetch", "origin"]);
    assert(JSON.stringify(gitArgs) === JSON.stringify(["-c", "http.version=HTTP/1.1", "fetch", "origin"]),
      `Git network command did not force HTTP/1.1 for ${git}`);
  }
  const genericArgs = ["-e", "process.stdout.write('generic-wrapper-ok')"];
  assert(JSON.stringify(networkCommandArgs(process.execPath, genericArgs)) === JSON.stringify(genericArgs), "non-Git network command arguments were modified");

  const timedOut = runNetworkCommand(process.execPath, ["-e", "setTimeout(()=>{},1000)"], {
    attempts: 1, timeoutMs: 25, baseDelayMs: 0,
  });
  assert(timedOut.error?.code === "ETIMEDOUT" && timedOut.attempts === 1,
    "network command did not enforce its per-attempt timeout");

  writeFileSync(counter, "0");
  const mutationTimeoutScript = "const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,String(Number(fs.readFileSync(p,'utf8'))+1));setTimeout(()=>{},1000)";
  const mutationTimeout = runNetworkCommand(process.execPath, ["-e", mutationTimeoutScript, counter], {
    attempts: 3, timeoutMs: 250, baseDelayMs: 0,
  });
  assert(mutationTimeout.error?.code === "ETIMEDOUT" && mutationTimeout.attempts === 1,
    "a timed-out non-replayable command was retried without explicit safe-retry classification");
  assert(readFileSync(counter, "utf8") === "1", "a timed-out command with a side effect ran more than once");
  console.log("network retry classification test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
