import contract from "../src/shared/policy-contract.json" with { type: "json" };
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
for (const name of Object.keys(contract.profiles)) {
  const policy = policyProfile(name);
  assert(policy.profile === name, `${name} profile identity drifted`);
  assert(Object.isFrozen(policy), `${name} normalized policy is mutable`);
}

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
function assert(condition, message) { if (!condition) throw new Error(message); }
