// @ts-check

import { opendir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathEntryIfExists } from "./path-inspection.mjs";

export const DIRECTORY_METADATA_BATCH_SIZE = 16;

export async function* directoryEntriesWithMetadata(directory, options = {}) {
  const openDirectory = options.openDirectory || opendir;
  const inspect = options.inspect || pathEntryIfExists;
  const throwIfCancelled = typeof options.throwIfCancelled === "function" ? options.throwIfCancelled : () => {};
  const context = options.context || {};
  const batchSize = positiveBatchSize(options.batchSize);
  const handle = await openDirectory(directory);
  let batch = [];
  for await (const entry of handle) {
    throwIfCancelled(context);
    batch.push({ entry, path: resolve(directory, entry.name) });
    if (batch.length < batchSize) continue;
    const settled = await inspectBatch(batch, inspect, throwIfCancelled, context);
    batch = [];
    for (const result of settled) {
      throwIfCancelled(context);
      if (result.status === "rejected") throw result.reason;
      yield result.value;
    }
  }
  if (!batch.length) return;
  const settled = await inspectBatch(batch, inspect, throwIfCancelled, context);
  for (const result of settled) {
    throwIfCancelled(context);
    if (result.status === "rejected") throw result.reason;
    yield result.value;
  }
}

async function inspectBatch(batch, inspect, throwIfCancelled, context) {
  return Promise.allSettled(batch.map(async (item) => {
    throwIfCancelled(context);
    return { ...item, info: await inspect(item.path) };
  }));
}

function positiveBatchSize(value) {
  return Number.isInteger(value) && value > 0 && value <= 64 ? value : DIRECTORY_METADATA_BATCH_SIZE;
}
