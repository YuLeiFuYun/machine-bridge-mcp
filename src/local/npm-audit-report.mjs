const LEVELS = ["info", "low", "moderate", "high", "critical"];

export function validateNpmAudit(report, exitCode = 0, label = "consumer") {
  const metadata = report?.metadata;
  const vulnerabilities = metadata?.vulnerabilities;
  if (!isRecord(report) || report.error !== undefined || !isRecord(metadata) || !isRecord(vulnerabilities)
    || ![...LEVELS, "total"].every(key => Object.hasOwn(vulnerabilities, key)
      && Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)) {
    throw new Error(`${label} npm audit metadata is incomplete`);
  }
  const total = LEVELS.reduce((sum, key) => sum + vulnerabilities[key], 0);
  if (!Number.isSafeInteger(total) || vulnerabilities.total !== total) throw new Error(`${label} npm audit total is inconsistent`);
  if (exitCode !== 0 || total !== 0) {
    throw new Error(`${label} production dependency audit failed (${LEVELS.map(key => `${key}=${vulnerabilities[key]}`).join(", ")})`);
  }
  return Object.freeze({ total: 0 });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
