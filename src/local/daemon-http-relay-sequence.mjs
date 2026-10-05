import relayContract from "../shared/relay-contract.json" with { type: "json" };

export class RelayOutboundSequence {
  constructor() { this.next = 1; this.acknowledged = 0; this.bytes = 0; this.messages = []; }
  enqueue(payload) {
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > relayContract.httpFallbackMaximumMessageBytes
        || this.messages.length >= relayContract.httpFallbackMaximumQueuedMessages
        || this.bytes + bytes > relayContract.httpFallbackMaximumQueuedBytes) {
      throw new Error("daemon HTTP relay outbound queue capacity exceeded");
    }
    this.messages.push({ seq: this.next++, payload, bytes });
    this.bytes += bytes;
  }
  acknowledge(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= this.next) return false;
    if (sequence <= this.acknowledged) return true;
    this.acknowledged = sequence;
    while (this.messages[0]?.seq <= sequence) {
      const removed = this.messages.shift();
      if (removed) this.bytes = Math.max(0, this.bytes - removed.bytes);
    }
    return true;
  }
  snapshot(maximumBytes = relayContract.httpFallbackMaximumEnvelopeBytes) {
    const selected = []; let bytes = 2;
    for (const message of this.messages) {
      const item = { seq: message.seq, payload: message.payload };
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (selected.length ? 1 : 0);
      if (bytes + itemBytes > maximumBytes) break;
      selected.push(item); bytes += itemBytes;
    }
    return selected;
  }
  reset() { this.next = 1; this.acknowledged = 0; this.bytes = 0; this.messages.length = 0; }
}

export class RelayInboundSequence {
  constructor() { this.acknowledged = 0; }
  classify(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return "gap";
    if (sequence <= this.acknowledged) return "duplicate";
    return sequence === this.acknowledged + 1 ? "new" : "gap";
  }
  commit(sequence) {
    if (sequence !== this.acknowledged + 1) throw new Error("daemon HTTP relay inbound sequence is not contiguous");
    this.acknowledged = sequence;
  }
  reset() { this.acknowledged = 0; }
}
