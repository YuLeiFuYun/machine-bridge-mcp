// @ts-check

export const SEARCH_FILE_BATCH_SIZE = 16;

/**
 * @typedef {object} SearchWorkspaceOptions
 * @property {number} maximumFiles
 * @property {number} maximumMatches
 * @property {(file: string) => Promise<Record<string, unknown>[]>} searchFile
 * @property {(onFile: (file: string) => Promise<boolean>) => Promise<{truncated?: boolean}>} walk
 * @property {(context: unknown) => void} [throwIfCancelled]
 * @property {unknown} [context]
 * @property {number} [batchSize]
 */

/** @param {SearchWorkspaceOptions} options */
export async function searchWorkspaceFiles(options) {
  const maximumFiles = options.maximumFiles;
  const maximumMatches = options.maximumMatches;
  const throwIfCancelled = typeof options.throwIfCancelled === "function" ? options.throwIfCancelled : () => {};
  const context = options.context || {};
  const batchSize = boundedBatchSize(options.batchSize);
  /** @type {Record<string, unknown>[]} */
  const matches = [];
  let visitedFiles = 0;
  let scheduledFiles = 0;
  /** @type {string[]} */
  let batch = [];

  const flush = async () => {
    const current = batch;
    batch = [];
    const settled = await Promise.allSettled(current.map(async (file) => {
      throwIfCancelled(context);
      return options.searchFile(file);
    }));
    for (const result of settled) {
      throwIfCancelled(context);
      if (matches.length >= maximumMatches || visitedFiles >= maximumFiles) return false;
      visitedFiles += 1;
      if (result.status === "rejected") throw result.reason;
      for (const match of result.value) {
        if (matches.length >= maximumMatches) break;
        matches.push(match);
      }
    }
    return matches.length < maximumMatches && visitedFiles < maximumFiles;
  };

  const walkResult = await options.walk(async (file) => {
    throwIfCancelled(context);
    if (matches.length >= maximumMatches || scheduledFiles >= maximumFiles) return false;
    scheduledFiles += 1;
    batch.push(file);
    if (batch.length < batchSize && scheduledFiles < maximumFiles) return true;
    return flush();
  });

  if (batch.length && matches.length < maximumMatches && visitedFiles < maximumFiles) await flush();
  return {
    matches,
    visitedFiles,
    truncated: matches.length >= maximumMatches || visitedFiles >= maximumFiles || walkResult.truncated === true,
  };
}

/** @param {unknown} value */
function boundedBatchSize(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 64
    ? value
    : SEARCH_FILE_BATCH_SIZE;
}
