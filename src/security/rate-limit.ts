/** Token bucket. One per integration; shared by every tool in it. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until one token is available. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  /** Wait for a token, up to maxWaitMs. Returns false if it would take longer. */
  async take(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (this.tryTake()) return true;
      const wait = this.waitMs();
      if (wait > maxWaitMs) return false;
      maxWaitMs -= wait;
      await sleep(wait, signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
