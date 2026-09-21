import relayContract from "../shared/relay-contract.json" with { type: "json" };

// Convert the bounded public header to a duration once; scheduling uses monotonic time.
export function relayRetryAfterMs(statusCode, value, now = Date.now()) {
  if (![429, 503].includes(statusCode) || typeof value !== "string" || value.length > 128) return 0;
  const text = value.trim();
  let delay;
  if (/^[0-9]+$/.test(text)) delay = Number(text) * 1000;
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    delay = Date.parse(text) - now;
  } else return 0;
  return boundedRelayRetryAfterMs(delay);
}

export function boundedRelayRetryAfterMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), relayContract.httpFallbackMaximumRetryAfterMs) : 0;
}

export function relayFailureBackoffMs(failures, base, maximum) {
  const exponent = Math.min(Math.max(0, failures - 1), 16);
  return Math.min(base * (2 ** exponent), Math.max(base, maximum));
}
