export interface PendingHighRiskRequest {
  prompt: string;
  useMemory: boolean;
}

export class HighRiskConfirmation {
  private pendingRequest: PendingHighRiskRequest | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ttlMs = 60_000) {}

  stage(prompt: string, useMemory = true): void {
    this.clear();
    this.pendingRequest = { prompt, useMemory };
    this.expiryTimer = setTimeout(() => this.clear(), this.ttlMs);
    this.expiryTimer.unref();
  }

  consume(): PendingHighRiskRequest | undefined {
    const request = this.pendingRequest;
    this.clear();
    return request;
  }

  cancel(): boolean {
    const existed = this.pendingRequest !== undefined;
    this.clear();
    return existed;
  }

  hasPending(): boolean {
    return this.pendingRequest !== undefined;
  }

  private clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.pendingRequest = undefined;
  }
}
