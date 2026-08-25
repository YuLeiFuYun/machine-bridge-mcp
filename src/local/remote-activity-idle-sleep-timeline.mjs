export class RemoteActivityIdleSleepTimeline {
  constructor({ wallNow = Date.now } = {}) {
    this.wallNow = wallNow;
    this.lastActivityStartedAt = 0;
    this.lastActivityEndedAt = 0;
    this.graceReleaseDueAt = 0;
    this.lastReleaseAt = 0;
    this.lastReleaseReason = null;
  }

  activityStarted() { this.lastActivityStartedAt = this.wallNow(); }
  activityEnded() { this.lastActivityEndedAt = this.wallNow(); }
  graceArmed(graceMs) { this.graceReleaseDueAt = this.wallNow() + graceMs; }
  graceCancelled() { this.graceReleaseDueAt = 0; }
  released(reason) {
    this.lastReleaseAt = this.wallNow();
    this.lastReleaseReason = reason;
  }

  snapshot() {
    return {
      grace_release_due_at: isoTime(this.graceReleaseDueAt),
      last_activity_started_at: isoTime(this.lastActivityStartedAt),
      last_activity_ended_at: isoTime(this.lastActivityEndedAt),
      last_release_at: isoTime(this.lastReleaseAt),
      last_release_reason: this.lastReleaseReason,
    };
  }
}

function isoTime(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
