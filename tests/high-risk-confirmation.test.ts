import { afterEach, describe, expect, it, vi } from "vitest";
import { HighRiskConfirmation } from "../src/security/high-risk-confirmation.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("HighRiskConfirmation", () => {
  it("returns a staged prompt exactly once", () => {
    const confirmation = new HighRiskConfirmation();
    confirmation.stage("synthetic high-risk request");
    expect(confirmation.consume()).toEqual({
      prompt: "synthetic high-risk request",
      useMemory: true,
    });
    expect(confirmation.consume()).toBeUndefined();
  });

  it("keeps the per-task memory opt-out attached to the confirmed request", () => {
    const confirmation = new HighRiskConfirmation();
    confirmation.stage("synthetic high-risk request", false);
    expect(confirmation.consume()).toEqual({
      prompt: "synthetic high-risk request",
      useMemory: false,
    });
  });

  it("discards a pending prompt on cancel", () => {
    const confirmation = new HighRiskConfirmation();
    confirmation.stage("synthetic high-risk request");
    expect(confirmation.cancel()).toBe(true);
    expect(confirmation.consume()).toBeUndefined();
  });

  it("reports whether a confirmation is pending", () => {
    const confirmation = new HighRiskConfirmation();
    expect(confirmation.hasPending()).toBe(false);
    confirmation.stage("synthetic high-risk request");
    expect(confirmation.hasPending()).toBe(true);
    confirmation.cancel();
    expect(confirmation.hasPending()).toBe(false);
  });

  it("discards a pending prompt after the timeout", () => {
    vi.useFakeTimers();
    const confirmation = new HighRiskConfirmation(1_000);
    confirmation.stage("synthetic high-risk request");
    vi.advanceTimersByTime(1_001);
    expect(confirmation.consume()).toBeUndefined();
  });
});
