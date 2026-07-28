const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 100;

export async function waitForActiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  return waitForStatus(readStatus, (status) => status?.active === true, { attempts, delayMs, sleep });
}


export async function waitForStableActiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, stableSamples = 5, sleep = delay, identity = stableIdentity } = {},
) {
  if (typeof readStatus !== "function") throw new TypeError("readStatus must be a function");
  if (typeof identity !== "function") throw new TypeError("identity must be a function");
  const maximum = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  const required = Number.isInteger(stableSamples) && stableSamples > 0 ? stableSamples : 5;
  let status = null;
  let consecutive = 0;
  let priorIdentity = null;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    status = await readStatus();
    const currentIdentity = status?.active === true ? identity(status) : null;
    const identityChanged = consecutive > 0
      && (priorIdentity !== null || currentIdentity !== null)
      && currentIdentity !== priorIdentity;
    if (status?.active === true && !identityChanged) consecutive += 1;
    else consecutive = status?.active === true ? 1 : 0;
    priorIdentity = currentIdentity;
    if (consecutive >= required) return { stable: true, status, samples: consecutive, attempts: attempt };
    if (attempt < maximum) await sleep(delayMs);
  }
  return { stable: false, status, samples: consecutive, attempts: maximum };
}

function stableIdentity(status) {
  if (Number.isInteger(status?.pid) && status.pid > 0) return `pid:${status.pid}`;
  if (typeof status?.last_run_time === "string" && status.last_run_time) return `run:${status.last_run_time}`;
  return null;
}

export async function waitForInactiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  return waitForStatus(readStatus, (status) => status?.active !== true, { attempts, delayMs, sleep });
}

export async function waitForStatus(
  readStatus,
  predicate,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  if (typeof readStatus !== "function") throw new TypeError("readStatus must be a function");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const maximum = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  let status = await readStatus();
  for (let attempt = 1; !predicate(status) && attempt < maximum; attempt += 1) {
    await sleep(delayMs);
    status = await readStatus();
  }
  return status;
}

function delay(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}
