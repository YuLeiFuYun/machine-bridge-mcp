import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { randomToken } from "./oauth-state.ts";
import { DaemonHttpChannel } from "./daemon-http-channel.ts";
import type { DaemonAttachment } from "./daemon-socket-attachment.ts";

export class DaemonHttpRegistry {
  private readonly channels = new Map<string, DaemonHttpChannel>();

  beginCandidate(sessionId: string, attachment: DaemonAttachment, now = Date.now()): DaemonHttpChannel | undefined {
    const existing = this.channels.get(sessionId);
    if (existing) { existing.touch(now); return existing; }
    this.pruneCandidates(now);
    if (this.channels.size >= 2) {
      const oldest = [...this.channels.values()]
        .filter((channel) => !channel.isActivated)
        .sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
      if (!oldest) return undefined;
      this.close(oldest);
    }
    const channel = new DaemonHttpChannel({
      sessionId, activationToken: randomToken("activate"), attachment, now,
    });
    this.channels.set(sessionId, channel);
    return channel;
  }

  get(sessionId: string): DaemonHttpChannel | undefined { return this.channels.get(sessionId); }

  readyChannels(now = Date.now()): DaemonHttpChannel[] {
    return [...this.channels.values()]
      .filter((channel) => channel.readyState === 1
        && now - channel.lastSeenMs < relayContract.httpFallbackLivenessTimeoutMs)
      .sort((left, right) => right.activatedMs - left.activatedMs);
  }

  candidates(now = Date.now()): DaemonHttpChannel[] {
    this.pruneCandidates(now);
    return [...this.channels.values()].filter((channel) => channel.readyState !== 1
      && now - channel.lastSeenMs < relayContract.httpFallbackLivenessTimeoutMs);
  }

  activate(sessionId: string, activationToken: string, now = Date.now()): DaemonHttpChannel | undefined {
    const channel = this.channels.get(sessionId);
    if (!channel || channel.activationToken !== activationToken) return undefined;
    channel.activate(now);
    return channel;
  }

  attachment(channel: DaemonHttpChannel): DaemonAttachment | undefined {
    return this.channels.get(channel.sessionId) === channel ? channel.attachment : undefined;
  }

  close(channel: DaemonHttpChannel): boolean {
    if (this.channels.get(channel.sessionId) !== channel) return false;
    this.channels.delete(channel.sessionId);
    channel.close();
    return true;
  }

  staleReady(now = Date.now()): DaemonHttpChannel[] {
    return [...this.channels.values()].filter((channel) => channel.readyState === 1
      && now - channel.lastSeenMs >= relayContract.httpFallbackLivenessTimeoutMs);
  }

  staleOwned(now = Date.now()): DaemonHttpChannel[] {
    return [...this.channels.values()].filter((channel) => channel.isActivated
      && now - channel.lastSeenMs >= relayContract.httpFallbackLivenessTimeoutMs);
  }

  nextDeadline(now = Date.now()): number {
    const deadlines = [...this.channels.values()].map((channel) => channel.lastSeenMs + relayContract.httpFallbackLivenessTimeoutMs);
    return deadlines.length > 0 ? Math.max(now + 1, Math.min(...deadlines)) : Number.POSITIVE_INFINITY;
  }

  private pruneCandidates(now = Date.now()): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.isActivated) continue;
      if (now - channel.lastSeenMs < relayContract.httpFallbackLivenessTimeoutMs) continue;
      this.close(channel);
    }
  }
}
