const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAXIMUM_DURATION_MS = 300_000;

export function createHardenedDownloadTimeout(artifactName, request, options = {}) {
  const schedule = typeof options.schedule === "function" ? options.schedule : setTimeout;
  const cancel = typeof options.cancel === "function" ? options.cancel : clearTimeout;
  const idleMs = boundedDuration(options.idleMs, DEFAULT_IDLE_TIMEOUT_MS, 1, DEFAULT_IDLE_TIMEOUT_MS);
  const maximumMs = boundedDuration(options.maximumMs, DEFAULT_MAXIMUM_DURATION_MS, idleMs, DEFAULT_MAXIMUM_DURATION_MS);
  let idleTimer = null;
  let maximumTimer = null;
  let finished = false;

  const cancelTimers = () => {
    if (idleTimer !== null) cancel(idleTimer);
    if (maximumTimer !== null) cancel(maximumTimer);
    idleTimer = null;
    maximumTimer = null;
  };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    cancelTimers();
    request.destroy(Object.assign(new Error(`${artifactName} tarball ${message}`), { code: "ETIMEDOUT" }));
  };
  const armIdle = () => {
    if (finished) return;
    if (idleTimer !== null) cancel(idleTimer);
    idleTimer = schedule(() => fail("download stalled"), idleMs);
  };

  maximumTimer = schedule(() => fail("download exceeded its maximum duration"), maximumMs);
  armIdle();
  return Object.freeze({
    progress: armIdle,
    clear() {
      finished = true;
      cancelTimers();
    },
  });
}

function boundedDuration(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
