import assert from "node:assert/strict";
import { releaseCommandFailure, releaseCommandLabel, releaseDiagnostic } from "../scripts/release-diagnostic.mjs";

const npmToken = ["npm", "_", "abcdefghijklmnopqrstuvwxyz", "1234567890"].join("");
const syntheticHome = ["", "Users", "synthetic-user", "project"].join("/");
const credentialUrl = ["https://", "synthetic-user", ":", "synthetic-password", "@registry.example.invalid/package"].join("");
const diagnostic = releaseDiagnostic([
  `npm_token=${npmToken}`,
  `registry=${credentialUrl}`,
  "email=owner@example.invalid",
  `path=${syntheticHome}`,
  "line-two",
].join("\n"), 300);
assert(!diagnostic.includes(npmToken), "npm token was not redacted");
assert(!diagnostic.includes("synthetic-user:synthetic-password"), "URL credentials were not redacted");
assert(!diagnostic.includes("owner@example.invalid"), "email was not redacted");
assert(!diagnostic.includes("synthetic-user"), "home path was not redacted");
assert(!diagnostic.includes("\n"), "diagnostic retained a literal line break");
assert(diagnostic.includes("\\n"), "diagnostic did not preserve bounded line-break evidence");
assert(releaseDiagnostic("x".repeat(500), 64).length <= 64, "release diagnostic exceeded its bound");
assert.equal(releaseCommandLabel("/private/tooling/git", ["fetch", "origin", "main"]), "git fetch");
const failure = releaseCommandFailure("/private/tooling/npm", ["publish", "--registry-auth=synthetic-secret"], {
  status: 1,
  stderr: `Bearer ${["eyJ", "header", "payload", "signature"].join(".")}\n${syntheticHome}`,
});
assert(failure.startsWith("npm publish failed:"), "release command failure omitted the bounded command label");
assert(!failure.includes("--registry-auth") && !failure.includes("header.payload") && !failure.includes("synthetic-user"),
  "release command failure exposed arguments, bearer material, or a home path");
console.log("release diagnostic redaction test ok");
