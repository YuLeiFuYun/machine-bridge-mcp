#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertPublishTag, parseReleaseVersion } from "./release-channel.mjs";
import { releaseDiagnosticEvent } from "./release-diagnostic.mjs";

try {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const parsed = parseReleaseVersion(pkg.version);
  const configured = String(process.env.npm_config_tag || "latest").trim().toLowerCase() || "latest";
  assertPublishTag(parsed.raw, configured);
  console.log(`npm publication channel verified: ${parsed.raw} -> ${parsed.npmTag}`);
} catch (error) {
  console.error(JSON.stringify(releaseDiagnosticEvent("npm.publication_policy.failed", error?.message || error, 1000)));
  process.exit(1);
}
