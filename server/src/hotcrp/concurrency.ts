// A minimal concurrency limiter (no dependency): at most `max` tasks run at
// once; the rest wait in FIFO order.

export class Limiter {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  readonly max: number;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`Limiter: max must be a positive integer, got ${max}`);
    this.max = max;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}
