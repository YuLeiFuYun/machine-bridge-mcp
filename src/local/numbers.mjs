export function clampInteger(value, fallback, minimum, maximum) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  const number = Number.isInteger(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}
