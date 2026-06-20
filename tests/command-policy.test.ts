import { describe, expect, it } from "vitest";
import {
  guardConfirmedHighRiskOutput,
  requiresConfirmation,
} from "../src/security/command-policy.js";

describe("requiresConfirmation", () => {
  it("flags destructive commands", () => {
    expect(requiresConfirmation("请执行 git reset --hard")).toBe(true);
    expect(requiresConfirmation("Remove-Item -Recurse demo")).toBe(true);
  });

  it("allows ordinary read-only requests", () => {
    expect(requiresConfirmation("帮我检查 TypeScript 报错")).toBe(false);
  });

  it("does not return a destructive bypass command after confirmation", () => {
    const guarded = guardConfirmedHighRiskOutput(
      '请在本机运行 Remove-Item -LiteralPath "synthetic-test.txt"',
    );
    expect(guarded).not.toContain("Remove-Item");
    expect(guarded).toContain("没有执行");
  });
});
