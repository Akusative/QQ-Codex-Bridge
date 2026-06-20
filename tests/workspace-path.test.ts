import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFileInsideRoot } from "../src/security/workspace-path.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace file policy", () => {
  it("allows a regular file inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-root-"));
    cleanup.push(root);
    const nested = join(root, "nested");
    const file = join(nested, "test.txt");
    await mkdir(nested);
    await writeFile(file, "safe test", "utf8");

    await expect(ensureFileInsideRoot(file, root)).resolves.toBe(file);
  });

  it("rejects a file outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-root-"));
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
    cleanup.push(root, outside);
    const file = join(outside, "test.txt");
    await writeFile(file, "safe test", "utf8");

    await expect(ensureFileInsideRoot(file, root)).rejects.toThrow(/outside/);
  });
});
