import { lstatSync } from "node:fs";
import { readBoundedRegularFileWithInfoSync, unlinkRegularFileIfIdentitySync } from "./secure-file.mjs";

const MAX_SERVICE_DEFINITION_BYTES = 256 * 1024;

export function snapshotServiceDefinition(file, label = "service definition") {
  try {
    return readBoundedRegularFileWithInfoSync(file, MAX_SERVICE_DEFINITION_BYTES, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    }).identity;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null;
    throw error;
  }
}

export function removeServiceDefinitionIfCurrent(file, expectedIdentity, label = "service definition") {
  if (!expectedIdentity) {
    try { lstatSync(file, { bigint: true }); return false; }
    catch (error) { if (error?.code === "ENOENT") return true; throw error; }
  }
  return unlinkRegularFileIfIdentitySync(file, expectedIdentity, label);
}
