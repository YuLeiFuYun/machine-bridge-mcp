import { registerHooks } from "node:module";

const runnerUrl = new URL("../../src/local/job-runner.mjs", import.meta.url).href;
const fixtureUrl = new URL("./managed-job-resource-admission-fixture.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./resource-admission.mjs" && context.parentURL === runnerUrl) {
      return { url: fixtureUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== runnerUrl) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const anchor = "cleanupError ||= error;";
    if (source.split(anchor).length !== 2) throw new Error("managed-job cleanup diagnostic anchor changed");
    return { ...loaded, source: source.replace(anchor, `${anchor}\n      ${cleanupDiagnosticSource}`) };
  },
});

// Test-only failure evidence: retain fixed operation classes and function names,
// without publishing paths, exception messages, request data, or credentials.
const cleanupDiagnosticSource = `
const diagnosticCode = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO"].includes(error?.code) ? error.code : "other";
const diagnosticPath = typeof error?.path === "string" ? error.path.replaceAll("\\\\", "/") : "";
const diagnosticNamespace = diagnosticPath.includes("/leases/") ? "resource_lease"
  : diagnosticPath.includes("/waiters/") ? "resource_waiter"
  : diagnosticPath.endsWith("/active-child.json") ? "active_child"
  : diagnosticPath.endsWith("/status.json") ? "job_status" : "other";
const diagnosticFrames = typeof error?.stack === "string" ? error.stack.split("\\n").slice(1, 9)
  .map((line) => /^\\s*at (?:async )?([A-Za-z_$][A-Za-z0-9_$.]*)\\s*\\(/.exec(line)?.[1] || "anonymous") : [];
process.stderr.write(JSON.stringify({ event: "fixture.cleanup.failure", code: diagnosticCode,
  namespace: diagnosticNamespace, frames: diagnosticFrames }) + "\\n");
`;
