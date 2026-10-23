import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Architecture documentation is one set: the entry point plus its detail documents under
 * docs/architecture/. Contracts assert sentences, not locations, so moving a paragraph into a
 * detail document must not silently retire an assertion that still describes the system.
 */
export const architectureDocumentation = [
  join(root, "docs", "ARCHITECTURE.md"),
  ...readdirSync(join(root, "docs", "architecture"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(root, "docs", "architecture", name)),
].map((file) => readFileSync(file, "utf8")).join("\n");
