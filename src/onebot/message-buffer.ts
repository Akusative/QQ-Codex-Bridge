export interface BufferedTextMessage<Event> {
  event: Event;
  text: string;
}

interface PendingBuffer<Event> {
  messages: Array<BufferedTextMessage<Event>>;
  timer: NodeJS.Timeout;
}

export class SlidingMessageBuffer<Event> {
  private readonly pending = new Map<string, PendingBuffer<Event>>();

  constructor(
    private readonly onFlush: (
      event: Event,
      combinedText: string,
      messageCount: number,
    ) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async enqueue(key: string, event: Event, text: string, waitMs: number): Promise<void> {
    if (waitMs <= 0) {
      await this.onFlush(event, text, 1);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const messages = existing?.messages ?? [];
    messages.push({ event, text });
    const timer = setTimeout(() => {
      void this.flush(key).catch(this.onError);
    }, waitMs);
    this.pending.set(key, { messages, timer });
  }

  async flush(key: string): Promise<boolean> {
    const buffered = this.pending.get(key);
    if (!buffered) return false;
    this.pending.delete(key);
    clearTimeout(buffered.timer);
    const last = buffered.messages.at(-1);
    if (!last) return false;
    await this.onFlush(
      last.event,
      buffered.messages.map((message) => message.text).join("\n"),
      buffered.messages.length,
    );
    return true;
  }

  cancel(key: string): boolean {
    const buffered = this.pending.get(key);
    if (!buffered) return false;
    clearTimeout(buffered.timer);
    this.pending.delete(key);
    return true;
  }

  clear(): void {
    for (const buffered of this.pending.values()) clearTimeout(buffered.timer);
    this.pending.clear();
  }
}
