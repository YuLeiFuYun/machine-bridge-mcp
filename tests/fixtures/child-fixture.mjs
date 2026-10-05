import { BoundedOutput } from "../../src/local/bounded-output.mjs";
import { createChildProcessSettlement } from "../../src/local/child-process-settlement.mjs";

export function waitForFixtureExit(child, timeoutMs = 10_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => { clearTimeout(timer); child.off("exit", onExit); resolve(); };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("fixture child did not exit within its cleanup budget"));
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

export async function stopFixtureChild(child, timeoutMs = 10_000, signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  try { await waitForFixtureExit(child, timeoutMs); }
  catch (error) {
    if (signal === "SIGKILL") throw error;
    child.kill("SIGKILL");
    try { await waitForFixtureExit(child, timeoutMs); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "fixture child cleanup failed"); }
  }
}

// Readiness owns failure cleanup because callers have not received the child yet.
export async function waitForFixtureReady(child, { timeoutMs = 10_000, label = "child" } = {}) {
  try {
    await new Promise((resolve, reject) => {
      let settled = false, stdout = "";
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        error ? reject(error) : resolve();
      };
      const onData = (chunk) => {
        const text = stdout + chunk;
        if (/(?:^|\n)ready\r?\n/.test(text)) finish();
        else stdout = text.slice(-4096);
      };
      const onError = (error) => finish(error);
      const onExit = (code) => finish(new Error(`${label} fixture exited before readiness (${code})`));
      const timer = setTimeout(() => finish(new Error(`${label} fixture did not become ready`)), timeoutMs);
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
      child.stderr.resume();
      if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode);
    });
  } catch (error) {
    try { await stopFixtureChild(child, 10_000, "SIGKILL"); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "fixture readiness and cleanup failed"); }
    throw error;
  }
}

// The caller's bounded prepare step runs after listeners are installed. This
// helper owns this directly spawned fixture, including preparation failures.
export async function runFixtureChild(child, { prepare, timeoutMs = 10_000, maxOutputBytes = 64 * 1024, label = "child" } = {}) {
  let stdout, stderr;
  let settled = false, timer, settlement, finish;
  const completion = new Promise((resolve, reject) => {
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
  });
  // A spawn/timeout failure may arrive while prepare is awaiting claim state.
  void completion.catch(() => {});
  const onError = (error) => finish(error);
  const onData = (target, chunk) => {
    if (settled) return;
    target.append(chunk);
    if (target.truncatedBytes) finish(new Error(`${label} fixture child exceeded its output budget`));
  };
  const onStdout = (chunk) => onData(stdout, chunk), onStderr = (chunk) => onData(stderr, chunk);
  const onExit = (code, signal) => settlement.onExit(code, signal);
  const onClose = (code, signal) => settlement.onClose(code, signal);
  let result, primary, failed = false;
  child.on("error", onError);
  try {
    stdout = new BoundedOutput(maxOutputBytes);
    stderr = new BoundedOutput(maxOutputBytes);
    settlement = createChildProcessSettlement({
      onSettle: (code, signal) => finish(null, { code, signal, stdout: stdout.text(), stderr: stderr.text() }),
      onFallback: () => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); },
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} fixture child did not close within its execution budget`)), timeoutMs);
    });
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    if (child.exitCode !== null || child.signalCode !== null) {
      const drained = [child.stdout, child.stderr].every(stream => !stream || stream.destroyed || stream.readableEnded);
      drained ? onClose(child.exitCode, child.signalCode) : onExit(child.exitCode, child.signalCode);
    }
    const prepared = Promise.resolve().then(() => prepare?.(child));
    result = await Promise.race([
      Promise.all([prepared, completion]).then(([, value]) => value),
      deadline,
    ]);
  } catch (error) { primary = error; failed = true; }
  finally {
    clearTimeout(timer);
    settlement?.cancel();
    try { await stopFixtureChild(child, 10_000, "SIGKILL"); }
    catch (error) {
      primary = failed ? new AggregateError([primary, error], "fixture execution and cleanup failed") : error;
      failed = true;
    }
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("close", onClose);
    child.stdout?.off("data", onStdout);
    child.stderr?.off("data", onStderr);
  }
  if (failed) throw primary;
  return result;
}
