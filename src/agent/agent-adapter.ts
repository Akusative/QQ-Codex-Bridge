export interface AgentRunOptions {
  prompt: string;
  workdir: string;
  timeoutMs: number;
  onProgress?: (text: string) => void;
}

export interface AgentRunResult {
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number | null;
}

export interface AgentAdapter {
  checkAvailable(): Promise<{ ok: boolean; detail: string }>;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  cancel(): Promise<boolean>;
  isBusy(): boolean;
}
