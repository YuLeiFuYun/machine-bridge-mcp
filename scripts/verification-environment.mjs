import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";

const VERIFICATION_ISOLATED_ENVIRONMENT_KEYS = new Set([
  "MBM_DEBUG",
  "MBM_MACOS_BACKGROUND_VISUAL_BACKEND",
  "MBM_MACOS_TRUST_BROKER",
  "MBM_RELAY_PROXY",
]);

export function verificationChildEnvironment(environment = process.env) {
  const result = nestedNpmEnvironment(environment);
  for (const key of Object.keys(result)) {
    if (VERIFICATION_ISOLATED_ENVIRONMENT_KEYS.has(key.toUpperCase())) delete result[key];
  }
  return result;
}
