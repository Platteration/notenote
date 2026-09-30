import { describe, expect, it } from "vitest";
import { WorkGate } from "@/lib/work-gate";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The gate in front of password verification. What it is for is bounding how many scrypts run at
 * once; what it must not do is refuse callers it could have served a moment later, because the
 * first version of that ceiling refused fourteen of twenty correct passwords while nine
 * connections of junk sign-ins were in flight.
 */
describe("a bounded queue in front of work", () => {
  it("runs no more than its slots at once and hands each one on as it is released", async () => {
    const gate = new WorkGate({ slots: 2, waiting: 10, waitMs: 1_000 });
    const slots = await Promise.all([gate.acquire(), gate.acquire()]);
    expect(slots.every(Boolean)).toBe(true);
    expect(gate.inFlight).toBe(2);

    let third: (() => void) | null = null;
    const queued = gate.acquire().then((slot) => (third = slot));
    await settle();
    // Nothing was refused and nothing was admitted: it is waiting.
    expect(third).toBeNull();
    expect(gate.waiting).toBe(1);

    slots[0]!();
    await queued;
    expect(third).not.toBeNull();
    expect(gate.inFlight).toBe(2);
  });

  it("serves waiters in the order they arrived, so a flood cannot starve one already queued", async () => {
    const gate = new WorkGate({ slots: 1, waiting: 10, waitMs: 1_000 });
    const held = (await gate.acquire())!;
    const order: number[] = [];
    const waiters = [0, 1, 2].map((n) =>
      gate.acquire().then((slot) => {
        order.push(n);
        slot?.();
      }),
    );
    await settle();
    held();
    await Promise.all(waiters);
    expect(order).toEqual([0, 1, 2]);
  });

  it("refuses once the waiting room is full rather than holding an unbounded number of callers", async () => {
    const gate = new WorkGate({ slots: 1, waiting: 2, waitMs: 1_000 });
    const held = (await gate.acquire())!;
    // Each waiter hands its slot straight back, so the one behind it can have it.
    const admitted: boolean[] = [];
    const queued = [0, 1].map(() =>
      gate.acquire().then((slot) => {
        admitted.push(slot !== null);
        slot?.();
      }),
    );
    await settle();
    expect(gate.waiting).toBe(2);
    // The third has nowhere to wait, and is told so at once rather than parked.
    expect(await gate.acquire()).toBeNull();
    held();
    await Promise.all(queued);
    expect(admitted).toEqual([true, true]);
  });

  it("refuses a caller whose wait runs out, and gives its place to nobody", async () => {
    const gate = new WorkGate({ slots: 1, waiting: 4, waitMs: 20 });
    const held = (await gate.acquire())!;
    expect(await gate.acquire()).toBeNull();
    expect(gate.waiting).toBe(0);
    held();
    // The gate is idle again, not holding a slot for the caller that gave up.
    expect(gate.inFlight).toBe(0);
    const after = await gate.acquire();
    expect(after).not.toBeNull();
  });

  it("counts a slot handed back twice only once", async () => {
    const gate = new WorkGate({ slots: 1, waiting: 1, waitMs: 50 });
    const slot = (await gate.acquire())!;
    slot();
    slot();
    expect(gate.inFlight).toBe(0);
    expect(await gate.acquire()).not.toBeNull();
    expect(gate.inFlight).toBe(1);
  });
});
