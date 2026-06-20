import { describe, expect, it } from "vitest";
import { MockAgentAdapter } from "../src/agent/mock-agent-adapter.js";

describe("MockAgentAdapter", () => {
  it("returns a deterministic mock result", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.run({
      prompt: "ping",
      workdir: process.cwd(),
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("4 个字符");
  });
});
