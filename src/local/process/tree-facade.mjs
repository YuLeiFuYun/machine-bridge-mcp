// @ts-check
export { terminateProcessTree } from "./tree.mjs";

export { DEFAULT_FORCE_TREE_SETTLEMENT_MS, terminateProcessTreeAndWait } from "./tree.mjs";

export {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateProcessTreeWithEscalation,
} from "./tree.mjs";

export {
  DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS,
  captureProcessTreeOwnership,
  processTreeOwnershipStillCurrent,
  refreshProcessTreeOwnership,
} from "./tree-snapshot.mjs";
