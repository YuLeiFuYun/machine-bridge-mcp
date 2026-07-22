import { withOwnerStateLock } from "./owner-state-lock.mjs";

const LOCK_PURPOSE = "operation-authorization";
const LOCK_FILE = "operation-authorization.lock";

export function withOperationStateLock(root, callback, options = {}) {
  return withOwnerStateLock(root, callback, {
    ...options,
    purpose: LOCK_PURPOSE,
    fileName: LOCK_FILE,
    label: "operation authorization",
  });
}
