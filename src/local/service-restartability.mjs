import { buildServiceSpec, previewAutostartDefinition } from "./service.mjs";
import { serviceEnvironmentSummary } from "./service-environment.mjs";
import { inspectRuntimePackageIdentity } from "./runtime-package-identity.mjs";

export function preflightServiceRestartability({ workspace, stateRoot, entryScript, expectedVersion,
  platform = process.platform, execPath = process.execPath, environment = process.env,
  serviceEnvironmentOptions = {} } = {}) {
  const runtime = inspectRuntimePackageIdentity(entryScript, { expectedVersion, platform });
  const serviceEnvironment = serviceEnvironmentSummary(stateRoot, serviceEnvironmentOptions);
  const spec = buildServiceSpec({ workspace, stateRoot, entryScript: runtime.entry, platform, execPath, environment });
  const definition = previewAutostartDefinition(spec, { platform });
  return Object.freeze({
    runtime,
    service_environment: Object.freeze({
      configured: serviceEnvironment.configured,
      keys: Object.freeze([...serviceEnvironment.keys]),
    }),
    provider: definition.provider,
  });
}
