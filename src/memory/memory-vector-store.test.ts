import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVectorStore } from "./memory-vector-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStore(): Promise<MemoryVectorStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-vec-"));
  dirs.push(dir);
  return new MemoryVectorStore(join(dir, "memory-vectors.json"));
}

describe("MemoryVectorStore", () => {
  it("set/snapshot 读回", async () => {
    const store = await makeStore();
    await store.set("p1", "bge-m3", [0.1, 0.2]);
    const lookup = await store.snapshot();
    expect(lookup("p1")).toEqual({ model: "bge-m3", vector: [0.1, 0.2] });
    expect(lookup("missing")).toBeUndefined();
  });

  it("setMany 批量写", async () => {
    const store = await makeStore();
    await store.setMany([
      { id: "a", model: "m", vector: [1] },
      { id: "b", model: "m", vector: [2] },
    ]);
    const lookup = await store.snapshot();
    expect(lookup("a")?.vector).toEqual([1]);
    expect(lookup("b")?.vector).toEqual([2]);
  });

  it("missing 找出缺当前模型向量的", async () => {
    const store = await makeStore();
    await store.set("has", "bge-m3", [1]);
    await store.set("oldmodel", "old", [1]);
    expect((await store.missing(["has", "oldmodel", "never"], "bge-m3")).sort()).toEqual([
      "never",
      "oldmodel",
    ]);
  });

  it("removeMany 删除", async () => {
    const store = await makeStore();
    await store.set("a", "m", [1]);
    await store.set("b", "m", [2]);
    await store.removeMany(["a"]);
    const lookup = await store.snapshot();
    expect(lookup("a")).toBeUndefined();
    expect(lookup("b")).toBeDefined();
  });

  it("跨实例持久化", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-vec-"));
    dirs.push(dir);
    const path = join(dir, "memory-vectors.json");
    await new MemoryVectorStore(path).set("a", "m", [1, 2, 3]);
    const lookup = await new MemoryVectorStore(path).snapshot();
    expect(lookup("a")?.vector).toEqual([1, 2, 3]);
  });
});
