import contract from "../src/shared/policy-contract.json" with { type: "json" };
import { resolvePolicy } from "../src/local/cli-policy.mjs";
import {
  DEFAULT_POLICY_REVISION,
  PolicyGate,
  assertToolAllowed,
  normalizePolicy,
  policyAllowsAvailability,
  policyProfile,
  toolNamesForPolicy,
} from "../src/local/policy.mjs";
import { BridgeError } from "../src/local/errors.mjs";

assert(DEFAULT_POLICY_REVISION === contract.revision, "policy revision drifted from shared contract");
for (const inherited of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
  expectBridgeError(() => policyProfile(inherited), "invalid_request");
  expectThrow(() => resolvePolicy({ profile: inherited }, {}), "--profile must be one of");
}
const repairedUnknown = normalizePolicy({
  profile: "constructor", origin: "custom", revision: contract.revision,
  allowWrite: true, execMode: "direct", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false,
});
assert(repairedUnknown.profile === "custom" && repairedUnknown.allowWrite && repairedUnknown.execMode === "direct", "unknown persisted profile was not repaired to an explicit custom policy");

for (const name of Object.keys(contract.profiles)) {
  const policy = policyProfile(name);
  assert(policy.profile === name, `${name} profile identity drifted`);
  assert(Object.isFrozen(policy), `${name} normalized policy is mutable`);
}

const cliPolicy = resolvePolicy({}, {});
const policyUpdatedAt = "2026-07-13T00:00:00.000Z";
cliPolicy.updatedAt = policyUpdatedAt;
assert(cliPolicy.updatedAt === policyUpdatedAt, "CLI policy state rejected persistence metadata");
assert(Object.isSealed(cliPolicy), "CLI policy state accepts undeclared fields");
assert(!Object.isFrozen(cliPolicy), "CLI policy state rejected its writable metadata field");
assert(Reflect.set(cliPolicy, "profile", "review") === false, "CLI policy capability field remained writable");
assert(cliPolicy.profile === contract.defaultProfile, "CLI policy capability was mutated");
assert(Object.isFrozen(normalizePolicy(cliPolicy)), "canonical policy normalization lost immutability");

const review = policyProfile("review");
const edit = policyProfile("edit");
const agent = policyProfile("agent");
const full = policyProfile("full");
assert(policyAllowsAvailability(review, "always"), "review lost read-only availability");
assert(!policyAllowsAvailability(review, "write"), "review gained write availability");
assert(policyAllowsAvailability(edit, "write"), "edit lost write availability");
assert(!policyAllowsAvailability(edit, "direct-exec"), "edit gained direct execution");
assert(policyAllowsAvailability(agent, "write+direct-exec"), "agent lost managed-job start capability");
assert(!policyAllowsAvailability(normalizePolicy({ profile: "custom", allowWrite: false, execMode: "direct" }), "write+direct-exec"), "custom direct-exec without write can start persistent jobs");
assert(policyAllowsAvailability(full, "full"), "canonical full lost full availability");

const reviewNames = new Set(toolNamesForPolicy(review));
assert(reviewNames.has("list_jobs") && reviewNames.has("read_job") && reviewNames.has("list_local_resources"), "read-only job/resource introspection is not available to review");
assert(!reviewNames.has("start_job") && !reviewNames.has("cancel_job"), "review gained managed-job mutations");
const agentNames = new Set(toolNamesForPolicy(agent));
assert(agentNames.has("start_job"), "agent cannot start a job despite write and direct-exec capabilities");

const gate = new PolicyGate(review);
assert(gate.allows("read_file") && !gate.allows("write_file"), "PolicyGate inventory is inconsistent");
expectBridgeError(() => gate.assert("write_file"), "policy_denied");
expectBridgeError(() => assertToolAllowed(review, "does_not_exist"), "not_found");
console.log("policy contract test ok");

function expectBridgeError(operation, code) {
  try { operation(); } catch (error) {
    assert(error instanceof BridgeError, "policy failure did not use BridgeError");
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected BridgeError ${code}`);
}
function expectThrow(operation, message) {
  try { operation(); } catch (error) {
    assert(String(error?.message || error).includes(message), `expected ${message}, received ${error?.message || error}`);
    return;
  }
  throw new Error(`expected error containing ${message}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
