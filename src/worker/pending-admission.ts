export class PendingAdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
