const changeSignals = new WeakMap();

export function resourceSleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("resource admission cancelled"));
    };
    timer = setTimeout(() => { cleanup(); resolvePromise(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resourceChangeSignal(owner) {
  let controller = changeSignals.get(owner);
  if (!controller || controller.signal.aborted) { controller = new AbortController(); changeSignals.set(owner, controller); }
  return controller.signal;
}

export function signalResourceChange(owner) {
  const previous = changeSignals.get(owner);
  changeSignals.set(owner, new AbortController());
  previous?.abort(new Error("resource capacity changed"));
}

export async function waitForResourceChange(changeSignal, ms, sleep = resourceSleep, signal) {
  const combined = signal ? AbortSignal.any([signal, changeSignal]) : changeSignal;
  try { await sleep(ms, combined); return false; }
  catch (error) { if (changeSignal.aborted && !signal?.aborted) return true; throw error; }
}

export function resourceRetryDelayMs({ attempt = 0, priority = "ordinary", reason = "", remainingMs = 0, random = Math.random } = {}) {
  const base = priority === "interactive" ? 100 : priority === "background" ? 500 : 200;
  const cap = priority === "interactive" ? 600 : priority === "background" ? 3_000 : 1_500;
  const step = Math.max(0, Math.min(4, Math.floor(Number(attempt) || 0)));
  let minimum = Math.min(cap, base * (2 ** step));
  if (reason === "host_pressure_red") minimum = Math.max(minimum, Math.min(cap, priority === "interactive" ? 300 : 600));
  else if (reason === "cpu_pressure_window") minimum = Math.max(minimum, Math.min(cap, priority === "interactive" ? 150 : 300));
  const maximum = Math.min(cap, Math.max(minimum, Math.floor(minimum * 1.5)));
  const unit = Math.max(0, Math.min(1, Number(random?.()) || 0));
  const delay = minimum + Math.floor((maximum - minimum) * unit);
  const remaining = Math.max(1, Math.floor(Number(remainingMs) || 1));
  return Math.max(1, Math.min(delay, remaining));
}
