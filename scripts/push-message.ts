import { loadConfig } from "../src/config.js";
import { OneBotApiClient } from "../src/onebot/api-client.js";
import { classifySensitiveContent } from "../src/security/sensitive-content-policy.js";

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    throw new Error('Usage: npm run push -- "message"');
  }

  const sensitive = classifySensitiveContent(text);
  if (sensitive.blocked) {
    throw new Error(
      `Outgoing message blocked by local sensitive-content policy (${sensitive.category})`,
    );
  }

  const config = loadConfig();
  const sender = new OneBotApiClient({
    baseUrl: config.ONEBOT_HTTP_URL,
    accessToken: config.ONEBOT_ACCESS_TOKEN,
    allowedUserId: config.ALLOWED_QQ_USER_ID,
  });

  await sender.sendPrivateText(config.ALLOWED_QQ_USER_ID, text);
  console.log("PASS Active QQ message sent to the allowed user");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown push failure";
  console.error(`FAIL Active QQ message: ${message}`);
  process.exitCode = 1;
});
