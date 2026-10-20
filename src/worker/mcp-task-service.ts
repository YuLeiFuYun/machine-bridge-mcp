import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import { issueManagedJobCapability } from "./managed-job-capability.ts";
import { McpTaskStore } from "./mcp-task-store.ts";
import type { TaskCredentialResolver } from "./mcp-tasks.ts";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;

export class McpTaskService {
  readonly store: McpTaskStore;
  readonly resolveCredentials: TaskCredentialResolver;
  private readonly identityKey: () => string;

  constructor(storage: Storage, identityKey: () => string) {
    this.store = new McpTaskStore(storage);
    this.identityKey = identityKey;
    this.resolveCredentials = async (taskId, authorized) => {
      const keyMaterial = this.identityKey();
      const [recovery_key, control_key] = await Promise.all([
        issueManagedJobCapability(keyMaterial, authorized, taskId, "read"),
        issueManagedJobCapability(keyMaterial, authorized, taskId, "control"),
      ]);
      return { recovery_key, control_key };
    };
  }

  async cancelAuthority(revocation: AuthorityRevocation, onFailure: (error: unknown) => void): Promise<number> {
    try { return await this.store.cancelAuthority(revocation); }
    catch (error) {
      try { onFailure(error); } catch { /* telemetry cannot block authority cleanup */ }
      return 0;
    }
  }
}
