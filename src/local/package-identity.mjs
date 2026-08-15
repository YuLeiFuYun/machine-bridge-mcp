import path from "node:path";
import { fileURLToPath } from "node:url";
import serverMetadata from "../shared/server-metadata.json" with { type: "json" };
import packageManifest from "../../package.json" with { type: "json" };

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const packageName = String(packageManifest.name);
export const packageVersion = String(packageManifest.version);
export const appName = String(serverMetadata.name);
