export function waitForSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => { cleanup(); resolvePromise(); };
    const onError = (error) => { cleanup(); rejectPromise(error); };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function sessionHasOutputAfter(session, stdoutOffset, stderrOffset) {
  return session.stdout.totalBytes > stdoutOffset || session.stderr.totalBytes > stderrOffset;
}

export function notifySessionWaiters(session) {
  for (const waiter of [...session.waiters]) waiter();
}

export function waitForSessionChange(session, waitMs, cancellationCheck) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const done = () => {
      cleanup();
      try {
        cancellationCheck();
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      session.waiters.delete(done);
    };
    session.waiters.add(done);
    timer = setTimeout(done, waitMs);
    timer.unref?.();
  });
}

export function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 4096) || "process failed";
}
