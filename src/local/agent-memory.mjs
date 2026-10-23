// @ts-check
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "./errors.mjs";
import { readOptionalRegularUtf8 } from "./agent-text-file.mjs";

export const PERSISTENT_MEMORY_FILE = join(".project-local", "agent-memory.json");
export const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 2048;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_CATEGORY_ITEMS = 10;
const CATEGORIES = ["project_insights", "ci_guidelines", "user_preferences", "notes"];

/** @typedef {{text: string, importance?: number, updated_at?: string, expires_at?: string, source?: string}} MemoryEntry */

/** @param {unknown} value */
function validDate(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {MemoryEntry} */
function memoryEntry(value) {
  const item = typeof value === "string" ? { text: value } : value;
  if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string" || !item.text.trim()) {
    throw new Error("Memory entries require non-empty text.");
  }
  /** @type {MemoryEntry} */
  const entry = { text: item.text.trim() };
  if (Buffer.byteLength(entry.text) > MAX_TEXT_BYTES) throw new Error("Memory entry exceeds the text limit.");
  if ("importance" in item) {
    if (typeof item.importance !== "number" || !Number.isFinite(item.importance) || item.importance < 1 || item.importance > 10) throw new Error("Invalid memory importance.");
    entry.importance = item.importance;
  }
  for (const field of ["updated_at", "expires_at"]) {
    if (field in item) {
      const value = Reflect.get(item, field);
      if (!validDate(value)) throw new Error("Invalid memory timestamp.");
      Reflect.set(entry, field, value);
    }
  }
  if ("timestamp" in item) {
    if (typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp) || !Number.isFinite(new Date(item.timestamp).getTime())) throw new Error("Invalid memory timestamp.");
    entry.updated_at ??= new Date(item.timestamp).toISOString();
  }
  if ("source" in item) {
    if (typeof item.source !== "string" || Buffer.byteLength(item.source) > 256) throw new Error("Invalid memory source.");
    entry.source = item.source;
  }
  return entry;
}

/**
 * Optional, untrusted project context. Read only on agent_context, never as execution authority.
 * Oversized files are rejected before allocation; output has one canonical, bounded entry view.
 * @param {string} scopeRoot
 * @param {() => void} [throwIfCancelled]
 * @param {(path: string) => void | Promise<void>} [assertPath]
 */
export async function readPersistentMemory(scopeRoot, throwIfCancelled = () => {}, assertPath = () => {}) {
  const memoryPath = join(scopeRoot, PERSISTENT_MEMORY_FILE);
  const base = { path: memoryPath, version: 1, authority: "untrusted-project-context", scope: "project" };
  throwIfCancelled();
  let file;
  try {
    file = await readOptionalRegularUtf8(memoryPath, MAX_MEMORY_BYTES, "project memory", assertPath);
  } catch (error) {
    throwIfCancelled();
    if (error instanceof BridgeError && error.code === "cancelled") throw error;
    const status = error instanceof BridgeError && error.code === "limit_exceeded" ? "too_large" : "unavailable";
    return { ...base, status, warning: status === "too_large" ? "Memory exceeds the 64 KiB input limit; content was not read." : "Memory could not be read safely; inspect the file and its path permissions." };
  }
  throwIfCancelled();
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) throw new Error("Memory requires version 1.");
    if (parsed.updated_at !== undefined && !validDate(parsed.updated_at)) throw new Error("Invalid memory timestamp.");
    /** @type {Record<string, MemoryEntry[]>} */
    const categories = {};
    let bytes = 0;
    let truncated = false;
    const now = Date.now();
    for (const category of CATEGORIES) {
      throwIfCancelled();
      const items = parsed[category] ?? [];
      if (!Array.isArray(items)) throw new Error("Memory categories must be arrays.");
      const entries = [];
      const seen = new Set();
      for (const item of items) {
        const entry = memoryEntry(item);
        if (entry.expires_at && Date.parse(entry.expires_at) <= now) continue;
        if (seen.has(entry.text)) continue;
        seen.add(entry.text);
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length >= MAX_CATEGORY_ITEMS || bytes + size > MAX_OUTPUT_BYTES) { truncated = true; continue; }
        entries.push(entry);
        bytes += size;
      }
      categories[category] = entries;
    }
    return { ...base, status: "ok", updated_at: parsed.updated_at ?? null, ...categories, truncated };
  } catch (error) {
    throwIfCancelled();
    if (error instanceof BridgeError && error.code === "cancelled") throw error;
    return { ...base, status: "invalid", warning: "Memory must contain version 1, bounded text entries and finite, valid metadata." };
  }
}

/**
 * Record a single memory item into persistent memory (.project-local/agent-memory.json).
 * Validates category, text, importance. Atomically updates the file.
 * @param {string} scopeRoot
 * @param {{category: string, text: string, importance?: number, source?: string, expires_at?: string}} item
 * @param {() => void} [throwIfCancelled]
 */
export async function recordPersistentMemory(scopeRoot, item, throwIfCancelled = () => {}) {
  throwIfCancelled();
  if (!item || typeof item !== "object") throw new BridgeError("invalid_request", "Memory entry must be an object.");
  const category = item.category;
  if (!CATEGORIES.includes(category)) {
    throw new BridgeError("invalid_request", `Invalid memory category "${category}". Expected one of: ${CATEGORIES.join(", ")}.`);
  }
  const entry = memoryEntry(item);
  entry.updated_at = new Date().toISOString();

  const memoryDir = join(scopeRoot, ".project-local");
  await mkdir(memoryDir, { recursive: true });
  const memoryPath = join(scopeRoot, PERSISTENT_MEMORY_FILE);

  /** @type {Record<string, any>} */
  const currentData = { version: 1, updated_at: entry.updated_at };
  for (const cat of CATEGORIES) {
    currentData[cat] = [];
  }

  const existing = /** @type {Record<string, any> | null} */ (await readPersistentMemory(scopeRoot, throwIfCancelled));
  if (existing && existing.status === "ok") {
    for (const cat of CATEGORIES) {
      if (Array.isArray(existing[cat])) {
        currentData[cat] = existing[cat].slice();
      }
    }
  }

  const list = currentData[category] || [];
  const existingIdx = list.findIndex(/** @param {any} e */ (e) => e && e.text === entry.text);
  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.push(entry);
    if (list.length > MAX_CATEGORY_ITEMS) {
      list.shift();
    }
  }
  currentData[category] = list;

  const serialized = `${JSON.stringify(currentData, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_MEMORY_BYTES) {
    throw new BridgeError("limit_exceeded", `Memory file exceeds maximum size (${MAX_MEMORY_BYTES} bytes).`);
  }

  throwIfCancelled();
  await writeFile(memoryPath, serialized, { mode: 0o600, encoding: "utf8" });
  return { recorded: true, category, entry, path: memoryPath };
}

/**
 * Remove matching memory items from persistent memory (.project-local/agent-memory.json).
 * @param {string} scopeRoot
 * @param {{category?: string, text?: string}} item
 * @param {() => void} [throwIfCancelled]
 */
export async function forgetPersistentMemory(scopeRoot, item, throwIfCancelled = () => {}) {
  throwIfCancelled();
  if (!item || typeof item !== "object") throw new BridgeError("invalid_request", "Filter item must be an object.");
  const memoryPath = join(scopeRoot, PERSISTENT_MEMORY_FILE);
  const existing = /** @type {Record<string, any> | null} */ (await readPersistentMemory(scopeRoot, throwIfCancelled));
  if (!existing || existing.status !== "ok") return { forgotten: 0, path: memoryPath };

  /** @type {Record<string, any>} */
  const currentData = { version: 1, updated_at: new Date().toISOString() };
  let removedCount = 0;
  for (const cat of CATEGORIES) {
    const list = Array.isArray(existing[cat]) ? existing[cat].slice() : [];
    if (!item.category || item.category === cat) {
      currentData[cat] = list.filter((/** @type {any} */ entry) => {
        const match = !item.text || (entry && entry.text.includes(item.text.trim()));
        if (match) removedCount += 1;
        return !match;
      });
    } else {
      currentData[cat] = list;
    }
  }

  const serialized = `${JSON.stringify(currentData, null, 2)}\n`;
  throwIfCancelled();
  await writeFile(memoryPath, serialized, { mode: 0o600, encoding: "utf8" });
  return { forgotten: removedCount, path: memoryPath };
}
