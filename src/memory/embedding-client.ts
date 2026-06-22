export interface EmbeddingClientOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

export interface TextEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * 硅基流动（SiliconFlow）embedding 客户端，OpenAI 兼容 /embeddings 接口。
 * 仅用于记忆检索；与 Codex/Claude 的生成预算无关。失败时抛错，由调用方回退到关键词检索。
 */
export class SiliconFlowEmbedder implements TextEmbedder {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: EmbeddingClientOptions) {
    if (!options.apiKey) throw new Error("SiliconFlow API key is required");
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.batchSize = Math.max(1, options.batchSize ?? 32);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input, encoding_format: "float" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`SiliconFlow embeddings HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error("SiliconFlow embeddings response is malformed");
    }
    // 按 index 归位（接口通常已有序，但稳妥起见排序）。
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new Error("SiliconFlow embeddings response is missing a vector");
      }
      return item.embedding;
    });
  }
}
