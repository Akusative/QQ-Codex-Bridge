import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    // 集成测试做真实 fs/git 操作，CI 慢机上默认 5s 容易假阳性超时。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
