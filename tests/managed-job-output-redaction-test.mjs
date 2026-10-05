import { resolve } from "node:path";
import { redactManagedJobOutput } from "../src/local/managed-job-output-redaction.mjs";

const emptyContext = {
  bytes: {}, paths: {}, sourcePaths: {}, temporaryPaths: {}, redactions: { empty: [""] },
};
assert(redactManagedJobOutput(Buffer.from("abc"), emptyContext, "/tmp/managed-job-redaction-runtime") === "abc",
  "empty managed-job redaction pattern expanded output instead of being ignored");

const malformedContext = {
  bytes: {}, paths: {}, sourcePaths: {}, temporaryPaths: {},
  redactions: { invalidItem: [{ secret: "x" }], invalidCollection: "abc" },
};
assert(redactManagedJobOutput(Buffer.from("abc"), malformedContext,
  "/tmp/managed-job-redaction-runtime", process.platform, 1) === "abc",
"malformed managed-job redaction patterns changed or crashed truncated output instead of being ignored");

const literalContext = {
  bytes: {}, paths: {}, sourcePaths: {}, temporaryPaths: {}, redactions: { secret: ["sensitive-value"] },
};
assert(redactManagedJobOutput(Buffer.from("before sensitive-value after"), literalContext,
  "/tmp/managed-job-redaction-runtime") === "before <redacted-resource:secret> after",
"valid managed-job literal redaction stopped replacing the complete protected value");
assert(redactManagedJobOutput(Buffer.from("before sensitive"), literalContext,
  "/tmp/managed-job-redaction-runtime", process.platform, 5) === "before ",
"truncated managed-job output retained a protected literal prefix at the capture boundary");

const overlappingBytes = {
  bytes: { short: Buffer.from("abc"), long: Buffer.from("abcdef") },
  paths: {}, sourcePaths: {}, temporaryPaths: {}, redactions: {},
};
assert(redactManagedJobOutput(Buffer.from("value=abcdef"), overlappingBytes,
  "/tmp/managed-job-redaction-runtime") === "value=<redacted-resource:long>",
"shorter managed-job resource bytes partially redacted a longer protected value");

const overlappingLiterals = {
  bytes: {}, paths: {}, sourcePaths: {}, temporaryPaths: {},
  redactions: { short: ["abc"], long: ["abcdef"] },
};
assert(redactManagedJobOutput(Buffer.from("value=abcdef"), overlappingLiterals,
  "/tmp/managed-job-redaction-runtime") === "value=<redacted-resource:long>",
"shorter managed-job literal partially redacted a longer protected value");

const overlappingCrossClass = {
  bytes: { shortBytes: Buffer.from("abc") }, paths: {}, sourcePaths: {}, temporaryPaths: {},
  redactions: { longLiteral: ["abcdef"] },
};
assert(redactManagedJobOutput(Buffer.from("value=abcdef"), overlappingCrossClass,
  "/tmp/managed-job-redaction-runtime") === "value=<redacted-resource:longLiteral>",
"byte-first redaction let a shorter resource value expose the suffix of a longer literal secret");

const shortPath = resolve("/tmp/managed-job-redaction-prefix");
const longPath = shortPath + "-long";
const overlappingPaths = {
  bytes: {}, paths: { short: shortPath, long: longPath }, sourcePaths: {}, temporaryPaths: {}, redactions: {},
};
assert(redactManagedJobOutput(Buffer.from("path=" + longPath), overlappingPaths,
  "/tmp/managed-job-redaction-runtime") === "path=<resource:long>",
"shorter managed-job path partially redacted a longer protected path");


const darwinContext = {
  bytes: {}, paths: { sample: "/private/tmp/job-alias/resource" },
  sourcePaths: { sample: ["/private/tmp/job-alias/source"] },
  temporaryPaths: { scratch: "/private/tmp/job-alias/temp" }, redactions: {},
};
assert(redactManagedJobOutput(Buffer.from("/tmp/job-alias/resource /tmp/job-alias/source /tmp/job-alias/temp /tmp/job-alias/runtime"),
  darwinContext, "/private/tmp/job-alias/runtime", "darwin")
  === "<resource:sample> <resource-source:sample> <temp:scratch> <job-runtime>",
"Darwin canonical aliases escaped managed-job result redaction");
assert(redactManagedJobOutput(Buffer.from("prefix /tmp/job-alias/reso"), darwinContext,
  "/private/tmp/job-alias/runtime", "darwin", 8) === "prefix ", "Darwin truncated alias escaped redaction");
const windowsContext = { bytes: {}, paths: { sample: "C:\\Private\\Resource" },
  sourcePaths: {}, temporaryPaths: {}, redactions: {} };
assert(redactManagedJobOutput(Buffer.from("C:\\PRIVATE\\RESOURCE"), windowsContext,
  "C:\\Private\\Runtime", "win32") === "<resource:sample>", "Windows complete case alias escaped redaction");
assert(redactManagedJobOutput(Buffer.from("prefix C:\\PRIVATE\\RESOU"), windowsContext,
  "C:\\Private\\Runtime", "win32", 5) === "prefix ", "Windows truncated case alias escaped redaction");
assert(redactManagedJobOutput(Buffer.from("/tmp/job-alias/resource"), darwinContext,
  "/private/tmp/job-alias/runtime", "linux") === "/tmp/job-alias/resource", "Darwin aliases changed Linux semantics");

console.log("managed-job output redaction test ok");

function assert(condition, message) { if (!condition) throw new Error(message); }
