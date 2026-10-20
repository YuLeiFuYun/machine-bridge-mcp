export const PROGRESS_BACKOFF_MS: readonly number[];
export function createProgressReporter(options: {
  progressToken?: string | number | null;
  emit: (notification: { progressToken: string | number; progress: number; message: string }) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  label?: string;
}): () => void;
export function formatElapsed(milliseconds: number): string;
