import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  existsSync,
  statSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunResult,
} from "./agent-adapter.js";

export interface CodexCliAdapterOptions {
  command: string;
  allowedWorkspaceRoot: string;
  availabilityTimeoutMs?: number;
}

export interface CodexLaunch {
  executable: string;
  argsPrefix: string[];
}

export function resolveCodexLaunch(command: string): CodexLaunch {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("CODEX_COMMAND is empty");

  if (/\.[cm]?js$/i.test(trimmed)) {
    return { executable: process.execPath, argsPrefix: [resolve(trimmed)] };
  }

  if (process.platform === "win32" && trimmed.toLowerCase() === "codex") {
    const appData = process.env.APPDATA;
    if (appData) {
      const npmEntry = join(
        appData,
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (existsSync(npmEntry)) {
        return { executable: process.execPath, argsPrefix: [npmEntry] };
      }
    }
    return { executable: "codex.exe", argsPrefix: [] };
  }

  return { executable: trimmed, argsPrefix: [] };
}

export function ensureAllowedWorkdir(workdir: string, allowedRoot: string): string {
  const target = resolve(workdir);
  const root = resolve(allowedRoot);
  const relation = relative(root, target);
  const outside =
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation);

  if (outside) {
    throw new Error("Workdir is outside ALLOWED_WORKSPACE_ROOT");
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error("Workdir does not exist or is not a directory");
  }
  return target;
}

function appendCapped(current: string, next: Buffer, limit = 64_000): string {
  const combined = current + next.toString("utf8");
  return combined.length <= limit ? combined : combined.slice(-limit);
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.killed) return;

  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }

  await new Promise<void>((resolveDone) => {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.once("error", () => {
      child.kill();
      resolveDone();
    });
    killer.once("close", () => resolveDone());
  });
}

export class CodexCliAdapter implements AgentAdapter {
  private readonly launch: CodexLaunch;
  private activeChild: ChildProcessWithoutNullStreams | undefined;
  private cancelRequested = false;

  constructor(private readonly options: CodexCliAdapterOptions) {
    this.launch = resolveCodexLaunch(options.command);
  }

  async checkAvailable(): Promise<{ ok: boolean; detail: string }> {
    const timeoutMs = this.options.availabilityTimeoutMs ?? 10_000;
    return new Promise((resolveResult) => {
      let stdout = "";
      let settled = false;
      const child = spawn(
        this.launch.executable,
        [...this.launch.argsPrefix, "--version"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      const finish = (result: { ok: boolean; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, detail: "Codex CLI availability check timed out" });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk, 1_000);
      });
      child.once("error", () => {
        finish({ ok: false, detail: "Codex CLI could not be started" });
      });
      child.once("close", (code) => {
        const version = stdout.trim().split(/\r?\n/)[0] || "version unknown";
        finish(
          code === 0
            ? { ok: true, detail: `Codex CLI is available (${version})` }
            : { ok: false, detail: `Codex CLI exited with code ${code}` },
        );
      });
    });
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (this.activeChild) {
      return {
        ok: false,
        output: "",
        error: "Another Codex task is already running",
        exitCode: null,
      };
    }

    let safeWorkdir: string;
    try {
      safeWorkdir = ensureAllowedWorkdir(
        options.workdir,
        this.options.allowedWorkspaceRoot,
      );
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : "Invalid workdir",
        exitCode: null,
      };
    }

    const tempDirectory = await mkdtemp(join(tmpdir(), "qq-codex-bridge-"));
    const finalMessagePath = join(tempDirectory, "final-message.txt");
    this.cancelRequested = false;
    options.onProgress?.("Codex task started");

    try {
      const args = [
        ...this.launch.argsPrefix,
        "-a",
        "never",
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--cd",
        safeWorkdir,
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-last-message",
        finalMessagePath,
        "-",
      ];

      const child = spawn(this.launch.executable, args, {
        cwd: safeWorkdir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });
      this.activeChild = child;
      child.stdin.end(options.prompt, "utf8");

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const processResult = await new Promise<{
        code: number | null;
        startError: boolean;
      }>((resolveResult) => {
        let settled = false;
        const finish = (result: { code: number | null; startError: boolean }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveResult(result);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          void terminateProcessTree(child);
        }, options.timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = appendCapped(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendCapped(stderr, chunk);
        });
        child.once("error", () => finish({ code: null, startError: true }));
        child.once("close", (code) => finish({ code, startError: false }));
      });

      this.activeChild = undefined;

      if (this.cancelRequested) {
        return { ok: false, output: "", error: "Task cancelled", exitCode: null };
      }
      if (timedOut) {
        return { ok: false, output: "", error: "Task timed out", exitCode: null };
      }
      if (processResult.startError) {
        return {
          ok: false,
          output: "",
          error: "Codex CLI could not be started",
          exitCode: null,
        };
      }

      const finalOutput = await readFile(finalMessagePath, "utf8").catch(() => "");
      if (processResult.code !== 0) {
        return {
          ok: false,
          output: "",
          error: `Codex exited with code ${processResult.code}`,
          exitCode: processResult.code,
        };
      }

      return {
        ok: true,
        output: finalOutput.trim() || "Codex completed without a final response",
        exitCode: processResult.code,
      };
    } finally {
      this.activeChild = undefined;
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async cancel(): Promise<boolean> {
    const child = this.activeChild;
    if (!child) return false;
    this.cancelRequested = true;
    await terminateProcessTree(child);
    return true;
  }

  isBusy(): boolean {
    return this.activeChild !== undefined;
  }
}
