export class RelayInboundState {
  constructor(now) {
    this.now = now;
    this.lastInboundAt = 0;
    this.lastApplicationInboundAt = 0;
  }

  reset() {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
  }

  observeTransportProof(transport) {
    this.lastInboundAt = this.now();
    transport.observeInbound();
  }

  observeApplicationInbound(application) {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    application.observeInbound();
  }

  observeApplicationProof(transport, application) {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    transport.observeInbound();
    application.observeInbound();
  }

  silenceMs(now = this.now()) {
    return this.lastInboundAt > 0 ? Math.max(0, Number(now) - this.lastInboundAt) : 0;
  }

  applicationSilenceMs(now = this.now()) {
    return Math.max(0, Number(now) - this.lastApplicationInboundAt);
  }
}
