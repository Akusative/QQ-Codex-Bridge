import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger redaction", () => {
  it("removes access tokens and authorization headers", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }) as unknown as DestinationStream;
    const logger = createLogger("info", destination);

    logger.info(
      {
        accessToken: "synthetic-secret-value",
        headers: { authorization: "Bearer synthetic-header-value" },
      },
      "redaction test",
    );

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("synthetic-secret-value");
    expect(output).not.toContain("synthetic-header-value");
  });
});
