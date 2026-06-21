import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDecayStore } from "./memory-decay-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStore(): Promise<MemoryDecayStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-decay-"));
  dirs.push(dir);
  return new MemoryDecayStore(join(dir, "memory-decay.json"));
}

describe("MemoryDecayStore", () => {
  it("缺文件时 get 返回 undefined", async () => {
    const store = await makeStore();
    expect(await store.get("a")).toBeUndefined();
  });

  it("touch 累加 referenceCount 并刷新时间", async () => {
    const store = await makeStore();
    await store.touch(["a"], new Date("2026-06-20T00:00:00Z"));
    await store.touch(["a"], new Date("2026-06-21T00:00:00Z"));
    const record = await store.get("a");
    expect(record?.referenceCount).toBe(2);
    expect(record?.lastReferencedAt).toBe("2026-06-21T00:00:00.000Z");
  });

  it("snapshot 返回同步查询函数", async () => {
    const store = await makeStore();
    await store.touch(["x", "y"]);
    const lookup = await store.snapshot();
    expect(lookup("x")?.referenceCount).toBe(1);
    expect(lookup("z")).toBeUndefined();
  });

  it("prune 清理失效项", async () => {
    const store = await makeStore();
    await store.touch(["keep", "drop"]);
    await store.prune(["keep"]);
    expect(await store.get("drop")).toBeUndefined();
    expect(await store.get("keep")).toBeDefined();
  });

  it("touch 空数组不报错", async () => {
    const store = await makeStore();
    await expect(store.touch([])).resolves.toBeUndefined();
  });

  it("跨实例持久化", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-decay-"));
    dirs.push(dir);
    const path = join(dir, "memory-decay.json");
    await new MemoryDecayStore(path).touch(["a"]);
    expect(await new MemoryDecayStore(path).get("a")).toBeDefined();
  });

  describe("窗口归属", () => {
    it("assign 打标签，pathsForConversation 按窗口取回", async () => {
      const store = await makeStore();
      await store.assign("p1", "conv-A");
      await store.assign("p2", "conv-A");
      await store.assign("p3", "conv-B");
      expect((await store.pathsForConversation("conv-A")).sort()).toEqual(["p1", "p2"]);
      expect(await store.pathsForConversation("conv-B")).toEqual(["p3"]);
    });

    it("assign 保留已有衰减状态；touch 保留窗口归属", async () => {
      const store = await makeStore();
      await store.touch(["p1"]);
      await store.assign("p1", "conv-A");
      const after = await store.get("p1");
      expect(after?.referenceCount).toBe(1);
      expect(after?.conversationId).toBe("conv-A");
      await store.touch(["p1"]);
      expect((await store.get("p1"))?.conversationId).toBe("conv-A");
    });

    it("removeMany 清掉这些项", async () => {
      const store = await makeStore();
      await store.assign("p1", "conv-A");
      await store.assign("p2", "conv-A");
      await store.removeMany(["p1"]);
      expect(await store.get("p1")).toBeUndefined();
      expect(await store.get("p2")).toBeDefined();
    });
  });
});
