import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureAllowedWorkdir,
  resolveCodexLaunch,
} from "../src/agent/codex-cli-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("CodexCliAdapter helpers", () => {
  it("accepts an existing workdir inside the allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-root-"));
    temporaryDirectories.push(root);
    const nested = join(root, "nested");
    await mkdir(nested);

    expect(ensureAllowedWorkdir(nested, root)).toBe(nested);
  });

  it("rejects a workdir outside the allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-root-"));
    const outside = await mkdtemp(join(tmpdir(), "codex-outside-"));
    temporaryDirectories.push(root, outside);

    expect(() => ensureAllowedWorkdir(outside, root)).toThrow(/outside/);
  });

  it("launches an explicit JavaScript entry through the current Node runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-entry-"));
    temporaryDirectories.push(root);
    const entry = join(root, "codex.js");
    await writeFile(entry, "", "utf8");

    expect(resolveCodexLaunch(entry)).toEqual({
      executable: process.execPath,
      argsPrefix: [entry],
    });
  });
});
