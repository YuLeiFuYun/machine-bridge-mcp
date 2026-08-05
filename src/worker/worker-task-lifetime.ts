interface WorkerTaskContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function retainWorkerTask(
  context: WorkerTaskContext,
  task: Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  const retained = Promise.resolve(task).then(
    () => undefined,
    (error) => {
      try { onError(error); } catch { /* diagnostic callbacks must not create a second rejection */ }
    },
  );
  context.waitUntil(retained);
  return retained;
}
