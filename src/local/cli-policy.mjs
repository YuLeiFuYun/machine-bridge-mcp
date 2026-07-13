import {
  DEFAULT_POLICY_PROFILE,
  DEFAULT_POLICY_REVISION,
  POLICY_PROFILES,
  normalizePolicy,
  policyProfile,
} from "./policy.mjs";

const POLICY_OVERRIDE_KEYS = Object.freeze(["execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths"]);

export function resolvePolicy(args = {}, stored = {}) {
  const hasStored = stored && typeof stored === "object" && (
    typeof stored.allowWrite === "boolean" || typeof stored.allowExec === "boolean" || typeof stored.execMode === "string"
  );
  const explicitKeys = ["profile", ...POLICY_OVERRIDE_KEYS];
  const hasExplicit = explicitKeys.some((key) => Object.prototype.hasOwnProperty.call(args, key));
  const base = { ...selectPolicyBase(args, stored, hasStored) };
  if (!hasExplicit) return policyState(base);
  applyPolicyOverrides(base, args);
  if (args.profile === undefined || POLICY_OVERRIDE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    base.profile = "custom";
    base.origin = "custom";
    base.revision = DEFAULT_POLICY_REVISION;
  }
  return policyState(base);
}

function policyState(policy) {
  // Capability fields retain the canonical immutable contract. The CLI owns a
  // sealed persistence record with exactly one writable metadata field.
  const normalized = normalizePolicy(policy);
  const state = {};
  for (const [key, value] of Object.entries(normalized)) {
    Object.defineProperty(state, key, { value, enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperty(state, "updatedAt", { value: undefined, enumerable: true, writable: true, configurable: false });
  return Object.seal(state);
}

function selectPolicyBase(args, stored, hasStored) {
  if (args.profile !== undefined) {
    const profile = String(args.profile).trim().toLowerCase();
    if (!POLICY_PROFILES[profile]) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
    return policyProfile(profile, "explicit");
  }
  if (hasStored) return migrateLegacyPolicy(stored);
  return policyProfile(DEFAULT_POLICY_PROFILE, "default");
}

function applyPolicyOverrides(policy, args) {
  if (args.execMode !== undefined) {
    const execMode = String(args.execMode).trim().toLowerCase();
    if (!["off", "direct", "shell"].includes(execMode)) throw new Error("--exec-mode must be off, direct, or shell");
    policy.execMode = execMode;
  }
  applyBooleanOverride(args, "noWrite", (enabled) => { policy.allowWrite = !enabled; });
  applyBooleanOverride(args, "noExec", (enabled) => {
    if (enabled) policy.execMode = "off";
    else if (policy.execMode === "off") policy.execMode = "direct";
  });
  applyBooleanOverride(args, "fullEnv", (enabled) => { policy.minimalEnv = !enabled; });
  applyBooleanOverride(args, "unrestrictedPaths", (enabled) => { policy.unrestrictedPaths = enabled; });
  applyBooleanOverride(args, "absolutePaths", (enabled) => { policy.exposeAbsolutePaths = enabled; });
}

function applyBooleanOverride(args, key, apply) {
  if (typeof args[key] === "boolean") apply(args[key]);
}

function migrateLegacyPolicy(stored = {}) {
  if (stored.origin === "default" && Number(stored.revision || 0) < DEFAULT_POLICY_REVISION) {
    return policyProfile(DEFAULT_POLICY_PROFILE, "default");
  }
  if (stored.origin === "migrated" && Number(stored.revision || 0) < DEFAULT_POLICY_REVISION) {
    return policyProfile(DEFAULT_POLICY_PROFILE, "migrated");
  }
  if (stored.origin) return normalizePolicy(stored);
  const normalized = normalizePolicy(stored);
  const looksLikeLegacyImplicitDefault = (
    normalized.profile === "custom"
    && normalized.allowWrite === true
    && normalized.execMode === "shell"
    && normalized.unrestrictedPaths === false
    && normalized.minimalEnv === true
    && normalized.exposeAbsolutePaths === false
  );
  if (looksLikeLegacyImplicitDefault) return policyProfile("full", "migrated");
  return normalizePolicy({ ...normalized, origin: "legacy-preserved", revision: DEFAULT_POLICY_REVISION });
}
