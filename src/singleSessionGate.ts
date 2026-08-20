/**
 * Process-wide async gate for the single Partslink24 browser session.
 *
 * Partslink24 accounts may permit only one active interactive login. Every
 * caller must therefore probe/reuse the shared BrowserContext serially instead
 * of racing into a second login attempt.
 */
export class SingleSessionGate {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
