import { afterEach, describe, expect, it, vi } from "vitest";
import { SlidingMessageBuffer } from "../src/onebot/message-buffer.js";

afterEach(() => vi.useRealTimers());

describe("SlidingMessageBuffer", () => {
  it("resets the quiet-period timer and flushes ordered messages once", async () => {
    vi.useFakeTimers();
    const flushed: Array<{ id: number; text: string; count: number }> = [];
    const buffer = new SlidingMessageBuffer<{ id: number }>(async (event, text, count) => {
      flushed.push({ id: event.id, text, count });
    });

    await buffer.enqueue("user", { id: 1 }, "A", 10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await buffer.enqueue("user", { id: 2 }, "B", 10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await buffer.enqueue("user", { id: 3 }, "C", 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(flushed).toEqual([{ id: 3, text: "A\nB\nC", count: 3 }]);
  });

  it("can be disabled with a zero wait and can cancel pending text", async () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const buffer = new SlidingMessageBuffer<{}>(async (_event, text) => {
      flushed.push(text);
    });

    await buffer.enqueue("user", {}, "immediate", 0);
    await buffer.enqueue("user", {}, "discarded", 10_000);
    expect(buffer.cancel("user")).toBe(true);
    await vi.runAllTimersAsync();
    expect(flushed).toEqual(["immediate"]);
  });
});
