const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 100;

export async function waitForInactiveStatus(
  readStatus,
  { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep = delay } = {},
) {
  if (typeof readStatus !== "function") throw new TypeError("readStatus must be a function");
  const maximum = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  let status = await readStatus();
  for (let attempt = 1; status?.active === true && attempt < maximum; attempt += 1) {
    await sleep(delayMs);
    status = await readStatus();
  }
  return status;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
