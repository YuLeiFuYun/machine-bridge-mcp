import path from "node:path";
import { resolveTrustedExecutable } from "./trusted-executable.mjs";

export function resolveHardenedNpmTarExecutable(stateRoot, options = {}) {
  const windowsRoot = String(options.windowsRoot || process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
  return resolveTrustedExecutable({
    platform: options.platform,
    candidates: [
      options.tarExecutable,
      path.join(windowsRoot, "System32", "tar.exe"),
      "/usr/bin/tar",
      "/bin/tar",
      "/usr/local/bin/tar",
    ].filter(Boolean),
    stateRoot,
    home: options.home,
    label: "tar extractor",
    reason: "trusted_tar_unavailable",
  });
}
