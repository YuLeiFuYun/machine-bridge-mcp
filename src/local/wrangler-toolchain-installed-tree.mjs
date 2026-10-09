import { privateToolchainIntegrityError } from "./private-toolchain-integrity.mjs";

const MAX_TREE_NODES = 20_000;

export function validateInstalledWranglerToolchainTree(tree, versions) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree is invalid");
  }
  if (tree.problems !== undefined && (!Array.isArray(tree.problems) || tree.problems.length)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains invalid edges");
  }
  const found = new Set();
  visitDependencyTree(tree.dependencies, versions, found, { value: 0 }, 0);
  for (const name of Object.keys(versions)) {
    if (!found.has(name)) throw privateToolchainIntegrityError(`Wrangler toolchain ${name} dependency is missing`);
  }
}

function visitDependencyTree(dependencies, versions, found, counter, depth) {
  if (dependencies === undefined) return;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency map");
  }
  if (depth > 64) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the depth limit");
  for (const name in dependencies) {
    if (!Object.hasOwn(dependencies, name)) continue;
    if (++counter.value > MAX_TREE_NODES) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the node limit");
    const value = dependencies[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency node");
    }
    if (Object.hasOwn(versions, name)) {
      if (typeof value.version !== "string") {
        throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version must be a string`);
      }
      if (value.version !== versions[name]) {
        throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version does not match the pinned version`);
      }
      found.add(name);
    }
    visitDependencyTree(value.dependencies, versions, found, counter, depth + 1);
  }
}
