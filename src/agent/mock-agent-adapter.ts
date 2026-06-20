import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunResult,
} from "./agent-adapter.js";

export class MockAgentAdapter implements AgentAdapter {
  private timer: NodeJS.Timeout | undefined;
  private cancelled = false;

  async checkAvailable() {
    return { ok: true, detail: "Mock agent is ready" };
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.cancelled = false;
    options.onProgress?.("Mock task started");

    await new Promise<void>((resolve) => {
      this.timer = setTimeout(resolve, 1_000);
    });
    this.timer = undefined;

    if (this.cancelled) {
      return { ok: false, output: "", error: "Task cancelled", exitCode: null };
    }

    return {
      ok: true,
      output: `模拟回复已收到（共 ${options.prompt.length} 个字符）`,
      exitCode: 0,
    };
  }

  async cancel(): Promise<boolean> {
    if (!this.timer) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cancelled = true;
    return true;
  }

  isBusy(): boolean {
    return this.timer !== undefined;
  }
}
