import { describe, expect, it } from "vitest";
import { normalizeRateLimitResponse } from "../src/agent/codex-rate-limit-client.js";

describe("Codex rate-limit response normalization", () => {
  it("selects the Codex bucket and maps five-hour and weekly windows", () => {
    const result = normalizeRateLimitResponse({
      rateLimits: {
        primary: { usedPercent: 99, windowDurationMins: 60 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 23,
            resetsAt: 1_800_000_000,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 61,
            resetsAt: 1_800_500_000,
            windowDurationMins: 10_080,
          },
        },
      },
    });

    expect(result.fiveHour).toMatchObject({
      usedPercent: 23,
      remainingPercent: 77,
      windowDurationMins: 300,
    });
    expect(result.weekly).toMatchObject({
      usedPercent: 61,
      remainingPercent: 39,
      windowDurationMins: 10_080,
    });
  });

  it("clamps unexpected percentages", () => {
    const result = normalizeRateLimitResponse({
      rateLimits: {
        primary: { usedPercent: 140, windowDurationMins: 300 },
        secondary: { usedPercent: -2, windowDurationMins: 10_080 },
      },
    });
    expect(result.fiveHour?.remainingPercent).toBe(0);
    expect(result.weekly?.remainingPercent).toBe(100);
  });
});
