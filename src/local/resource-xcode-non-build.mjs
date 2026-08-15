const GIB = 1024 ** 3;
const PACKAGE = new Set(["-resolvePackageDependencies"]);
const ARTIFACT = new Set(["-exportArchive", "-exportNotarizedApp", "-exportLocalizations", "-importLocalizations", "-create-xcframework"]);
const MAINTENANCE = new Set(["-runFirstLaunch", "-downloadAllPlatforms", "-prepareDeviceSupport", "-downloadPlatform", "-importPlatform", "-downloadComponent", "-importComponent"]);
const DELETE = new Set(["-deleteComponent"]);
const QUERY = new Set(["-showComponent", "-showdestinations", "-showTestPlans", "-showBuildSettings", "-showBuildSettingsForIndex", "-find-executable", "-find-library"]);

export function xcodeNonBuildResourcePlan(args) {
  const flags = new Set(args.map(String));
  if ([...MAINTENANCE].some((flag) => flags.has(flag))) return plan("xcode-maintenance", "unbounded", 6, 0.95, 2048, 8 * GIB, true, false);
  if ([...ARTIFACT].some((flag) => flags.has(flag))) return plan("xcode-artifact", "io", 1, 0.9, 1536, 8 * GIB, false, true);
  if ([...PACKAGE].some((flag) => flags.has(flag))) return plan("xcode-package-resolution", "mixed", 2, 0.65, 1536, 4 * GIB, false, true);
  if ([...DELETE].some((flag) => flags.has(flag))) return plan("xcode-maintenance", "io", 1, 0.9, 1024, 0, false, false);
  if ([...QUERY].some((flag) => flags.has(flag))) return plan("xcode-query", "adaptive", 0.75, 0.2, 768, 0, false, false);
  return null;
}
function plan(family, resourceClass, cpu, io, memoryMb, diskBytes, unbounded, serializeProject) {
  return { family, resourceClass, cpu, io, memoryMb, diskBytes, unbounded, serializeProject };
}
