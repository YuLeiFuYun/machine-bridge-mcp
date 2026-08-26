import { ResourceCoordinator as ProductionResourceCoordinator } from "../../src/local/resource-admission.mjs";
import { healthyResourceHost } from "./healthy-resource-host.mjs";

export class ResourceCoordinator extends ProductionResourceCoordinator {
  constructor(options = {}) {
    super({ ...options, sampleHost: healthyResourceHost });
  }
}
