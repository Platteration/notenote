/**
 * A bounded queue in front of work that must not all run at once.
 *
 * Held in memory and per process, like `lib/rate-limit.ts`, and for the same deployment shape.
 *
 * The distinction that matters here is between *delaying* a caller and *refusing* one. Password
 * verification has to be bounded — scrypt runs on libuv's four-thread pool and an unbounded
 * flood of it stalls every other request in the process — but a bound that answers "no" the
 * moment it is reached is a denial of service of its own: it is spent by whoever asks first,
 * which is the attacker, and the account owner's correct password is refused with everyone
 * else's. So a caller that finds every slot taken waits for one, and is only refused when the
 * waiting room is full or the wait runs out. Both of those are bounded on purpose: an unbounded
 * queue is an unbounded number of sockets and buffered bodies held open, which is the same
 * attack wearing a different hat.
 */
export interface WorkGateOptions {
  /** How many callers may hold a slot at once. */
  slots: number;
  /** How many may wait for one at once; past this a caller is refused rather than held. */
  waiting: number;
  /** How long a caller waits for a slot before it is refused. */
  waitMs: number;
}

/** Hand the slot back. Idempotent, so it is safe in a `finally` beside an early return. */
export type ReleaseSlot = () => void;

interface Waiter {
  resolve: (slot: ReleaseSlot | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkGate {
  private readonly options: WorkGateOptions;
  private readonly queue: Waiter[] = [];
  private running = 0;

  constructor(options: WorkGateOptions) {
    this.options = options;
  }

  /** How many callers are holding a slot. */
  get inFlight(): number {
    return this.running;
  }

  /** How many callers are waiting for one. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * A slot, or null when there was no room to wait or the wait ran out.
   *
   * First come, first served: a caller that arrives while the gate is busy is served before
   * later arrivals, so a steady flood cannot starve someone already in the queue.
   */
  acquire(): Promise<ReleaseSlot | null> {
    if (this.running < this.options.slots) return Promise.resolve(this.take());
    if (this.queue.length >= this.options.waiting) return Promise.resolve(null);
    return new Promise<ReleaseSlot | null>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          resolve(null);
        }, this.options.waitMs),
      };
      this.queue.push(waiter);
    });
  }

  /** Only for tests: forget the counts and refuse anyone still waiting. */
  reset(): void {
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.running = 0;
  }

  private take(): ReleaseSlot {
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.running < this.options.slots && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(this.take());
    }
  }
}
