import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWebUiAuthStorePath } from "../src/webui/webui-auth-path.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "webui-auth-path-"));
  cleanup.push(root);
  return root;
}

describe("WebUI auth store path", () => {
  it("keeps an existing persistent auth store unchanged", async () => {
    const root = await createRoot();
    const persistent = join(root, "data", "webui-auth.json");
    const legacy = join(root, "dist", "data", "webui-auth.json");
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(root, "dist", "data"), { recursive: true });
    await writeFile(persistent, "persistent", "utf8");
    await writeFile(legacy, "legacy", "utf8");

    await expect(prepareWebUiAuthStorePath(root)).resolves.toBe(persistent);
    await expect(readFile(persistent, "utf8")).resolves.toBe("persistent");
  });

  it("migrates the legacy auth store from dist", async () => {
    const root = await createRoot();
    const legacy = join(root, "dist", "data", "webui-auth.json");
    const persistent = join(root, "data", "webui-auth.json");
    await mkdir(join(root, "dist", "data"), { recursive: true });
    await writeFile(legacy, "legacy", "utf8");

    await expect(prepareWebUiAuthStorePath(root)).resolves.toBe(persistent);
    await expect(readFile(persistent, "utf8")).resolves.toBe("legacy");
  });

  it("recovers the newest available auth store from updater backups", async () => {
    const root = await createRoot();
    const older = join(root, "data", "updates", "backup-20260620-100000", "dist", "data");
    const newer = join(root, "data", "updates", "backup-20260621-100000", "dist", "data");
    const persistent = join(root, "data", "webui-auth.json");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, "webui-auth.json"), "older", "utf8");
    await writeFile(join(newer, "webui-auth.json"), "newer", "utf8");

    await expect(prepareWebUiAuthStorePath(root)).resolves.toBe(persistent);
    await expect(readFile(persistent, "utf8")).resolves.toBe("newer");
  });
});
