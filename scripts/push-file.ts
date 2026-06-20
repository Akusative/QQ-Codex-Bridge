import { basename, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { OneBotApiClient } from "../src/onebot/api-client.js";
import { ensureFileInsideRoot } from "../src/security/workspace-path.js";

async function main(): Promise<void> {
  const requestedPath = process.argv[2]?.trim();
  if (!requestedPath) {
    throw new Error('Usage: npm run push:file -- "path inside workspace"');
  }

  const config = loadConfig();
  const filePath = await ensureFileInsideRoot(
    resolve(requestedPath),
    config.ALLOWED_WORKSPACE_ROOT,
  );
  const sender = new OneBotApiClient({
    baseUrl: config.ONEBOT_HTTP_URL,
    accessToken: config.ONEBOT_ACCESS_TOKEN,
    allowedUserId: config.ALLOWED_QQ_USER_ID,
  });

  await sender.uploadPrivateFile(
    config.ALLOWED_QQ_USER_ID,
    filePath,
    basename(filePath),
  );
  console.log("PASS Private file sent to the allowed user");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown file push failure";
  console.error(`FAIL Private file: ${message}`);
  process.exitCode = 1;
});
