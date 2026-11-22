export interface ChildProcessIdentity {
  pid?: unknown;
  exitCode?: unknown;
  signalCode?: unknown;
}

export interface ProcessGroupEntry {
  pid: number;
  pgid: number;
  startedAt: number;
}

export interface ProcessOwnershipMember {
  pid: number;
  startedAt: number | null;
}

export interface ProcessOwnershipSnapshot {
  platform: string;
  pid: number;
  members: ProcessOwnershipMember[];
}

export interface ProcessSnapshotResult {
  error?: unknown;
  status?: number | null;
  stdout?: string | Buffer;
}

export interface ProcessOwnershipOptions {
  platform?: string;
  listProcessGroups?: (options: ProcessOwnershipOptions, pid: number, timeoutMs: number) => ProcessGroupEntry[] | Promise<ProcessGroupEntry[]>;
  execFileProcess?: (command: string, args: string[], options: Record<string, unknown>) => ProcessSnapshotResult | Promise<ProcessSnapshotResult>;
  ownershipCheckBudgetMs?: unknown;
  processSnapshotTimeoutMs?: unknown;
  monotonicNow?: () => number;
}
