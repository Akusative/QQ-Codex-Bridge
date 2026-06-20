import type { MemoryCandidate } from "./memory-commands.js";
import type { MemoryListEntry } from "./memory-repository.js";

type PendingMemory =
  | { type: "remember"; candidate: MemoryCandidate }
  | { type: "forget"; entry: MemoryListEntry };

export class MemoryDraftManager {
  private pending: PendingMemory | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ttlMs = 5 * 60_000) {}

  stageRemember(candidate: MemoryCandidate): void {
    this.stage({ type: "remember", candidate });
  }

  stageForget(entry: MemoryListEntry): void {
    this.stage({ type: "forget", entry });
  }

  getRemember(): MemoryCandidate | undefined {
    return this.pending?.type === "remember" ? this.pending.candidate : undefined;
  }

  getForget(): MemoryListEntry | undefined {
    return this.pending?.type === "forget" ? this.pending.entry : undefined;
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }

  cancel(): boolean {
    const existed = this.pending !== undefined;
    this.clear();
    return existed;
  }

  clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.pending = undefined;
  }

  private stage(pending: PendingMemory): void {
    this.clear();
    this.pending = pending;
    this.expiryTimer = setTimeout(() => this.clear(), this.ttlMs);
    this.expiryTimer.unref();
  }
}
