import { describe, expect, it } from "vitest";
import { Limiter } from "../../src/hotcrp/concurrency.js";

describe("Limiter", () => {
  it("never runs more than max tasks at once, and runs them all", async () => {
    const lim = new Limiter(2);
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        lim.run(async () => {
          peak = Math.max(peak, lim.active);
          await new Promise((r) => setTimeout(r, 2));
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("releases its slot when a task throws", async () => {
    const lim = new Limiter(1);
    await expect(lim.run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lim.run(() => Promise.resolve(1))).resolves.toBe(1);
  });

  it("rejects a bad max", () => {
    expect(() => new Limiter(0)).toThrow(RangeError);
  });
});
