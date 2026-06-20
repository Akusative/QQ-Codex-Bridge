import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agent/agent-adapter.js";
import {
  AutoMemoryCoordinator,
  parseAutomaticMemoryCandidates,
} from "../src/memory/auto-memory-coordinator.js";
import type { MemoryCandidate } from "../src/memory/memory-commands.js";
import { BridgeWorkspaceStore } from "../src/workspace/bridge-workspace-store.js";

class SummaryAgent implements AgentAdapter {
  runs: AgentRunOptions[] = [];

  async checkAvailable() { return { ok: true, detail: "available" }; }
  async run(options: AgentRunOptions) {
    this.runs.push(options);
    return {
      ok: true,
      output: JSON.stringify([{
        category: "preference",
        title: "偏好简洁回复",
        summary: "用户偏好简洁清楚的回复。",
        forgetCondition: "用户提出更新、纠正或删除时。",
      }]),
    };
  }
  async cancel() { return false; }
  isBusy() { return false; }
}

describe("AutoMemoryCoordinator", () => {
  it("parses only bounded structured memory candidates", () => {
    expect(parseAutomaticMemoryCandidates('说明\n[{"category":"rule","title":"保留规则","summary":"长期遵守该规则。","forgetCondition":"用户要求删除时。"}]')).toHaveLength(1);
    expect(parseAutomaticMemoryCandidates("not json")).toEqual([]);
  });

  it("summarizes after the configured token threshold and advances the cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-memory-"));
    const workspace = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await workspace.initialize();
    await workspace.updateMemorySettings({
      mode: "automatic",
      onConversationSwitch: false,
      onTokenThreshold: true,
      tokenThreshold: 1000,
      onSchedule: false,
      timezone: "UTC+8",
      time: "00:00",
    });
    const conversation = await workspace.createConversation("自动记忆");
    await workspace.appendMessage("user", "希望回复简洁。".repeat(300), conversation.id);
    const added: MemoryCandidate[] = [];
    const agent = new SummaryAgent();
    const coordinator = new AutoMemoryCoordinator(
      workspace,
      { add: async (candidate) => { added.push(candidate); return { synced: true }; } },
      agent,
      pino({ level: "silent" }),
      root,
      1000,
    );
    await coordinator.onConversationUpdated(conversation.id);
    expect(agent.runs).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect((await workspace.pendingMemorySummary(conversation.id)).messages).toHaveLength(0);
  });
});
