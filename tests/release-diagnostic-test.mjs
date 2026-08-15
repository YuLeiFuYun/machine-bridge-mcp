import assert from "node:assert/strict";
import { releaseCommandFailure, releaseCommandLabel, releaseDiagnostic, releaseDiagnosticEvent } from "../scripts/release-diagnostic.mjs";

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
const hostileEvent = releaseDiagnosticEvent("release.test.failed", `first\r\nsecond \u001b[31m ${npmToken} ${credentialUrl}`, 96);
const hostileLine = JSON.stringify(hostileEvent);
assert.equal(hostileLine.split("\n").length, 1, "serialized release diagnostic injected a second log line");
assert.deepEqual(JSON.parse(hostileLine), hostileEvent, "serialized release diagnostic changed event fields");
assert.equal(hostileEvent.event, "release.test.failed", "release diagnostic event name changed");
assert(hostileEvent.error.length <= 96, "release diagnostic event error exceeded its bound");
assert(!hostileLine.includes(npmToken) && !hostileLine.includes("synthetic-user:synthetic-password"),
  "release diagnostic event exposed token or URL credentials");
assert.throws(() => releaseDiagnosticEvent("Invalid Event", "error"), /event name is invalid/,
  "release diagnostic accepted an unsafe event name");
assert.equal(releaseCommandLabel("/private/tooling/git", ["fetch", "origin", "main"]), "git fetch");
const failure = releaseCommandFailure("/private/tooling/npm", ["publish", "--registry-auth=synthetic-secret"], {
  status: 1,
  stderr: `Bearer ${["eyJ", "header", "payload", "signature"].join(".")}\n${syntheticHome}`,
});
assert(failure.startsWith("npm publish failed:"), "release command failure omitted the bounded command label");
assert(!failure.includes("--registry-auth") && !failure.includes("header.payload") && !failure.includes("synthetic-user"),
  "release command failure exposed arguments, bearer material, or a home path");
console.log("release diagnostic redaction test ok");
