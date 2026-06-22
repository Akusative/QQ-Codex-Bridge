import { describe, it, expect, vi } from "vitest";
import { SiliconFlowEmbedder } from "./embedding-client.js";

function okResponse(vectors: number[][]) {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }),
    { status: 200 },
  );
}

describe("SiliconFlowEmbedder", () => {
  it("发出 OpenAI 兼容请求并解析向量", async () => {
    const fetchImpl = vi.fn(async () => okResponse([[1, 2, 3], [4, 5, 6]]));
    const embedder = new SiliconFlowEmbedder({
      apiKey: "secret",
      model: "BAAI/bge-m3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await embedder.embed(["你好", "世界"]);
    expect(result).toEqual([[1, 2, 3], [4, 5, 6]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.siliconflow.cn/v1/embeddings");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "BAAI/bge-m3",
      input: ["你好", "世界"],
    });
  });

  it("超出批量上限时分批请求", async () => {
    const fetchImpl = vi.fn(async () => okResponse([[1]]));
    const embedder = new SiliconFlowEmbedder({
      apiKey: "k",
      model: "m",
      batchSize: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await embedder.embed(["a", "b", "c"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("空输入不请求", async () => {
    const fetchImpl = vi.fn();
    const embedder = new SiliconFlowEmbedder({ apiKey: "k", model: "m", fetchImpl: fetchImpl as never });
    expect(await embedder.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("非 200 抛错", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const embedder = new SiliconFlowEmbedder({ apiKey: "k", model: "m", fetchImpl: fetchImpl as never });
    await expect(embedder.embed(["x"])).rejects.toThrow(/HTTP 429/);
  });

  it("数量不匹配抛错", async () => {
    const fetchImpl = vi.fn(async () => okResponse([[1]]));
    const embedder = new SiliconFlowEmbedder({ apiKey: "k", model: "m", fetchImpl: fetchImpl as never });
    await expect(embedder.embed(["x", "y"])).rejects.toThrow(/malformed/);
  });

  it("无 key 构造即抛错", () => {
    expect(() => new SiliconFlowEmbedder({ apiKey: "", model: "m" })).toThrow();
  });
});
