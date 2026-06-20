import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCodexLaunch } from "./codex-cli-adapter.js";

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface CodexRateLimitUsage {
  fetchedAt: number;
  fiveHour: CodexRateLimitWindow | null;
  weekly: CodexRateLimitWindow | null;
}

interface RawRateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

interface RawRateLimitSnapshot {
  limitId?: unknown;
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
}

interface RawRateLimitResponse {
  rateLimits?: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
}

export interface CodexRateLimitClientOptions {
  command: string;
  timeoutMs?: number;
  cacheMs?: number;
}

export class CodexRateLimitClient {
  private readonly launch;
  private cached: { expiresAt: number; value: CodexRateLimitUsage } | undefined;
  private inFlight: Promise<CodexRateLimitUsage> | undefined;

  constructor(private readonly options: CodexRateLimitClientOptions) {
    this.launch = resolveCodexLaunch(options.command);
  }

  async read(force = false): Promise<CodexRateLimitUsage> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.readFromCodex().then((value) => {
      this.cached = {
        value,
        expiresAt: Date.now() + (this.options.cacheMs ?? 30_000),
      };
      return value;
    }).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async readFromCodex(): Promise<CodexRateLimitUsage> {
    const timeoutMs = this.options.timeoutMs ?? 12_000;
    const child = spawn(
      this.launch.executable,
      [...this.launch.argsPrefix, "app-server", "--listen", "stdio://"],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const lines = createInterface({ input: child.stdout });

    return new Promise<CodexRateLimitUsage>((resolveResult, reject) => {
      let settled = false;
      let stderr = "";

      const finish = (error?: Error, value?: CodexRateLimitUsage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        void terminateProcessTree(child);
        if (error) reject(error);
        else resolveResult(value!);
      };

      const send = (message: unknown) => {
        if (!child.stdin.destroyed) {
          child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
        }
      };

      const timer = setTimeout(
        () => finish(new Error("Codex rate-limit query timed out")),
        timeoutMs,
      );

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
      });
      child.once("error", () => {
        finish(new Error("Codex app-server could not be started"));
      });
      child.once("close", (code) => {
        if (!settled) {
          const detail = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : "";
          finish(new Error(`Codex app-server exited with code ${code}${detail}`));
        }
      });
      lines.on("line", (line) => {
        let message: {
          id?: number;
          result?: RawRateLimitResponse;
          error?: { message?: string };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex initialization failed"));
            return;
          }
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 2, params: null });
          return;
        }

        if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex rate-limit query failed"));
            return;
          }
          try {
            finish(undefined, normalizeRateLimitResponse(message.result));
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Invalid Codex rate-limit response"));
          }
        }
      });

      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "qq_codex_bridge",
            title: "QQ Codex Bridge",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      });
    });
  }
}

export function normalizeRateLimitResponse(
  response: RawRateLimitResponse | undefined,
): CodexRateLimitUsage {
  if (!response) throw new Error("Codex returned no rate-limit data");
  const snapshots = Object.values(response.rateLimitsByLimitId ?? {});
  const snapshot =
    response.rateLimitsByLimitId?.codex ??
    snapshots.find((item) => item.limitId === "codex") ??
    response.rateLimits ??
    snapshots[0];
  if (!snapshot) throw new Error("Codex returned no rate-limit snapshot");

  const windows = [snapshot.primary, snapshot.secondary]
    .filter((item): item is RawRateLimitWindow => Boolean(item))
    .map(normalizeWindow);
  const fiveHour =
    windows.find((item) => item.windowDurationMins === 300) ??
    windows.find((item) => (item.windowDurationMins ?? Infinity) < 24 * 60) ??
    windows[0] ??
    null;
  const weekly =
    windows.find((item) => item.windowDurationMins === 7 * 24 * 60) ??
    windows.find((item) => (item.windowDurationMins ?? 0) >= 24 * 60) ??
    windows.find((item) => item !== fiveHour) ??
    null;

  return { fetchedAt: Date.now(), fiveHour, weekly };
}

function normalizeWindow(window: RawRateLimitWindow): CodexRateLimitWindow {
  const usedPercent = clampPercent(numberOrNull(window.usedPercent) ?? 0);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: numberOrNull(window.resetsAt),
    windowDurationMins: numberOrNull(window.windowDurationMins),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
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
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      child.kill();
      resolveDone();
    });
    killer.once("close", () => resolveDone());
  });
}
