import { privateToolchainIntegrityError } from "./private-toolchain-integrity.mjs";

const MAX_TREE_NODES = 20_000;

export function validateInstalledWranglerToolchainTree(tree, versions) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree is invalid");
  }
  if (tree.problems !== undefined && (!Array.isArray(tree.problems) || tree.problems.length)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains invalid edges");
  }
  const found = new Map([["cf", []], ["wrangler", []], ["undici", []], ["sharp", []], ["esbuild", []], ["workerd", []]]);
  visitDependencyTree(tree.dependencies, found, { value: 0 }, 0);
  for (const [name, expected] of Object.entries(versions)) {
    const actual = found.get(name) || [];
    if (!actual.length || actual.some((version) => version !== expected)) {
      throw privateToolchainIntegrityError(`Wrangler toolchain ${name} versions ${actual.join(",") || "missing"} do not match ${expected}`);
    }
  }
}

function visitDependencyTree(dependencies, found, counter, depth) {
  if (dependencies === undefined) return;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency map");
  }
  if (depth > 64) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the depth limit");
  for (const [name, value] of Object.entries(dependencies)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency node");
    }
    counter.value += 1;
    if (counter.value > MAX_TREE_NODES) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the node limit");
    if (found.has(name)) {
      if (typeof value.version !== "string") {
        throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version must be a string`);
      }
      found.get(name).push(value.version);
    }
    visitDependencyTree(value.dependencies, found, counter, depth + 1);
  }
}
