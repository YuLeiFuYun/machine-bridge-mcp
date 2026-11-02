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
});
