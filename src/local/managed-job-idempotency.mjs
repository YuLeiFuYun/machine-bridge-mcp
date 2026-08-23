import { createHash } from "node:crypto";
import { principalBinding } from "./authority-context.mjs";
import { BridgeError } from "./errors.mjs";

export function normalizeJobIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(value)) {
    throw new BridgeError("invalid_request", "idempotency_key must be a 1-128 character identifier using letters, digits, dot, underscore, tilde, colon, or hyphen");
  }
  return value;
}

export function omitJobIdempotencyKey(args) {
  const { idempotency_key: _ignored, ...planArgs } = args;
  return planArgs;
}

export function managedJobIdempotencyDigest(key, context) {
  const binding = principalBinding(context);
  const scope = binding.owner_kind === "account"
    ? [binding.owner_kind, binding.owner_account_id, binding.owner_account_version, binding.owner_client_id, binding.owner_family_id].join("\0")
    : "local";
  return createHash("sha256")
    .update("machine-bridge-managed-job-idempotency-v1\0")
    .update(scope)
    .update("\0")
    .update(key)
    .digest("hex");
}
