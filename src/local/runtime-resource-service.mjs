import { resolve } from "node:path";
import { inspectResourceFile } from "./managed-job-plan.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { expandHome } from "./state.mjs";
import { stateRootFromProfileStatePath } from "./runtime-paths.mjs";

const MAX_BROWSER_RESOURCE_BYTES = 1024 * 1024;

export class RuntimeResourceService {
  constructor({ workspace, resourceStatePath = "", currentResources, authorizeTool }) {
    this.workspace = resolve(workspace);
    this.resourceStatePath = resourceStatePath ? resolve(resourceStatePath) : "";
    this.currentResources = currentResources;
    this.authorizeTool = authorizeTool;
  }

  readBinary(name) {
    const registry = this.currentResources();
    const resource = Object.hasOwn(registry, name) ? registry[name] : null;
    if (!resource) throw new Error(`unknown local resource: ${name}`);
    const inspected = inspectResourceFile(resource.path, {
      allowInsecurePermissions: resource.allowInsecurePermissions === true,
      includeContent: true,
    });
    if (inspected.size > MAX_BROWSER_RESOURCE_BYTES) {
      throw new Error("local resource exceeds 1 MiB browser injection limit");
    }
    return {
      buffer: inspected.content,
      path: inspected.path,
      size: inspected.size,
    };
  }

  readText(name) {
    const { buffer } = this.readBinary(name);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`local resource is not valid UTF-8 text: ${name}`);
    }
  }

  async generateSshKey(args = {}) {
    this.authorizeTool("generate_ssh_key_resource");
    if (!this.resourceStatePath) throw new Error("local resource state is unavailable in this runtime");
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw new Error("HOME or USERPROFILE is required to choose a default SSH key path");
    const target = args.path
      ? resolve(expandHome(String(args.path)))
      : resolve(home, ".ssh", `machine-mcp-${args.name}-ed25519`);
    const key = await generateRegisteredSshKey({
      workspace: this.workspace,
      stateDir: stateRootFromProfileStatePath(this.resourceStatePath),
      name: args.name,
      targetPath: target,
      comment: args.comment || `machine-mcp:${args.name}`,
    });
    const exposePaths = args.expose_paths === true;
    return {
      name: key.name,
      created: key.created,
      registered: key.registered,
      fingerprint: key.fingerprint,
      key_type: key.keyType,
      private_mode: key.privateMode,
      public_mode: key.publicMode,
      private_key_content_exposed: key.privateKeyContentExposed,
      available_to_new_jobs_immediately: key.availableToNewJobsImmediately,
      paths_exposed: exposePaths,
      ...(exposePaths ? {
        private_key_path: resolve(key.privateKeyPath),
        public_key_path: resolve(key.publicKeyPath),
      } : {}),
    };
  }
}
