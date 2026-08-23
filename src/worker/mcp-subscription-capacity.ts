export const MAX_ACTIVE_MCP_SUBSCRIPTIONS = 32;
export const MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT = 8;
export const MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS = 64;

export class McpSubscriptionCapacity {
  private active = 0;
  private readonly byAccount = new Map<string, number>();
  private readonly openedAccounts = new Set<string>();

  reserve(accountId: string): (() => void) | null {
    const key = String(accountId || "");
    const accountActive = this.byAccount.get(key) ?? 0;
    if (!key || this.active >= MAX_ACTIVE_MCP_SUBSCRIPTIONS
        || accountActive >= MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT) return null;
    this.active += 1;
    this.byAccount.set(key, accountActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const remaining = Math.max(0, (this.byAccount.get(key) ?? 1) - 1);
      if (remaining) this.byAccount.set(key, remaining);
      else this.byAccount.delete(key);
    };
  }

  markOpened(accountId: string): void {
    const key = String(accountId || "");
    if (!key || (this.byAccount.get(key) ?? 0) <= 0) return;
    this.openedAccounts.delete(key);
    while (this.openedAccounts.size >= MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS) {
      const oldest = this.openedAccounts.values().next().value;
      if (typeof oldest !== "string") break;
      this.openedAccounts.delete(oldest);
    }
    this.openedAccounts.add(key);
  }

  snapshot(accountId: string): Readonly<{ activeForAccount: number; openedForAccount: boolean }> {
    const key = String(accountId || "");
    return Object.freeze({
      activeForAccount: key ? this.byAccount.get(key) ?? 0 : 0,
      openedForAccount: Boolean(key && this.openedAccounts.has(key)),
    });
  }
}
