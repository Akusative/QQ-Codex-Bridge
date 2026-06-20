import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import "dotenv/config";
import { ZodError } from "zod";
import { loadConfig, type BridgeConfig } from "../src/config.js";

type Check = { name: string; ok: boolean; detail: string };

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

const checks: Check[] = [];
let validatedConfig: BridgeConfig | undefined;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
checks.push({
  name: "Node.js",
  ok: nodeMajor >= 22,
  detail: `v${process.versions.node} (requires >= 22)`,
});

const envPath = path.resolve(".env");
checks.push({
  name: ".env",
  ok: await fileExists(envPath),
  detail: (await fileExists(envPath)) ? "present" : "missing",
});

const requiredNames = [
  "ONEBOT_HTTP_URL",
  "BRIDGE_WS_HOST",
  "BRIDGE_WS_PORT",
  "BRIDGE_WS_PATH",
  "ONEBOT_ACCESS_TOKEN",
  "ALLOWED_QQ_USER_ID",
  "CODEX_WORKDIR",
  "ALLOWED_WORKSPACE_ROOT",
] as const;
const missing = requiredNames.filter((name) => !process.env[name]);
checks.push({
  name: "Environment fields",
  ok: missing.length === 0,
  detail: missing.length === 0 ? "complete" : `missing: ${missing.join(", ")}`,
});

try {
  validatedConfig = loadConfig();
  checks.push({ name: "Environment format", ok: true, detail: "valid" });
} catch (error) {
  const detail =
    error instanceof ZodError
      ? error.issues
          .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
          .join("; ")
      : "invalid configuration";
  checks.push({ name: "Environment format", ok: false, detail });
}

if (validatedConfig) {
  checks.push({
    name: "Codex workdir",
    ok: await fileExists(validatedConfig.CODEX_WORKDIR),
    detail: validatedConfig.CODEX_WORKDIR,
  });
}

const wsHost = validatedConfig?.BRIDGE_WS_HOST ?? "127.0.0.1";
const wsPort = validatedConfig?.BRIDGE_WS_PORT ?? 3001;
checks.push({
  name: "Bridge WebSocket port",
  ok: await canListen(wsHost, wsPort),
  detail: `${wsHost}:${wsPort}`,
});

if (validatedConfig) {
  try {
    const response = await fetch(new URL("/get_status", validatedConfig.ONEBOT_HTTP_URL), {
      headers: { Authorization: `Bearer ${validatedConfig.ONEBOT_ACCESS_TOKEN}` },
    });
    checks.push({
      name: "OneBot HTTP",
      ok: response.ok,
      detail: `HTTP ${response.status}`,
    });
  } catch (error) {
    checks.push({ name: "OneBot HTTP", ok: false, detail: String(error) });
  }
}

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}

if (checks.some((check) => !check.ok)) process.exitCode = 1;
