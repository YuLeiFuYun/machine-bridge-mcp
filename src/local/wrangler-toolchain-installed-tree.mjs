import { privateToolchainIntegrityError } from "./private-toolchain-integrity.mjs";

const MAX_TREE_NODES = 20_000;

export function validateInstalledWranglerToolchainTree(tree, versions, lockedPackages) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree is invalid");
  }
  if (tree.problems !== undefined && (!Array.isArray(tree.problems) || tree.problems.length)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains invalid edges");
  }
  if (lockedPackages !== undefined
      && (!lockedPackages || typeof lockedPackages !== "object" || Array.isArray(lockedPackages))) {
    throw privateToolchainIntegrityError("Wrangler toolchain lock package map is invalid");
  }
  const found = new Set();
  visitDependencyTree(tree.dependencies, versions, found, { value: 0 }, 0, lockedPackages, "");
  for (const name of Object.keys(versions)) {
    if (!found.has(name)) throw privateToolchainIntegrityError(`Wrangler toolchain ${name} dependency is missing`);
  }
}

function visitDependencyTree(dependencies, versions, found, counter, depth, lockedPackages, parentLocation) {
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
    const pinned = Object.hasOwn(versions, name);
    if (pinned && typeof value.version !== "string") {
      throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version must be a string`);
    }
    const location = lockedPackages === undefined ? "" : resolveLockedDependency(lockedPackages, parentLocation, name);
    const expected = lockedPackages === undefined ? versions[name] : lockedPackages[location]?.version;
    if ((pinned || lockedPackages !== undefined)
        && (typeof expected !== "string" || value.version !== expected)) {
      throw privateToolchainIntegrityError(pinned
        ? `Wrangler toolchain ${name} version does not match the pinned version`
        : "Wrangler toolchain dependency version does not match its locked location");
    }
    // Nested pins may differ. They cannot substitute for the required root pins.
    if (pinned && (lockedPackages === undefined || location === `node_modules/${name}`)) {
      if (value.version !== versions[name]) {
        throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version does not match the pinned version`);
      }
      found.add(name);
    }
    visitDependencyTree(value.dependencies, versions, found, counter, depth + 1, lockedPackages, location);
  }
}

function resolveLockedDependency(packages, parentLocation, name) {
  let parent = parentLocation;
  for (;;) {
    const location = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`;
    if (Object.hasOwn(packages, location)) return location;
    if (!parent) break;
    const boundary = parent.lastIndexOf("/node_modules/");
    parent = boundary < 0 ? "" : parent.slice(0, boundary);
  }
  throw privateToolchainIntegrityError("Wrangler toolchain dependency is absent from its locked resolution path");
}
