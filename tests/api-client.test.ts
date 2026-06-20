import { describe, expect, it, vi } from "vitest";
import { OneBotApiClient } from "../src/onebot/api-client.js";

describe("OneBotApiClient", () => {
  it("sends an authenticated private message to the whitelisted user", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ status: "ok", retcode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        });
      },
    );
    const client = new OneBotApiClient({
      baseUrl: "http://127.0.0.1:3000",
      accessToken: "synthetic-local-token",
      allowedUserId: 10001,
      fetchImpl: fetchMock as typeof fetch,
    });

    await client.sendPrivateText(10001, "pong");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer synthetic-local-token",
    });
  });

  it("refuses to send outside the whitelist", async () => {
    const client = new OneBotApiClient({
      baseUrl: "http://127.0.0.1:3000",
      accessToken: "synthetic-local-token",
      allowedUserId: 10001,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.sendPrivateText(10002, "pong")).rejects.toThrow(
      "outside the whitelist",
    );
  });

  it("uploads a local private file to the whitelisted user", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedInput = input;
        capturedInit = init;
        return new Response(
          JSON.stringify({ status: "ok", retcode: 0, data: { file_id: "f1" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const client = new OneBotApiClient({
      baseUrl: "http://127.0.0.1:3000",
      accessToken: "synthetic-local-token",
      allowedUserId: 10001,
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(
      client.uploadPrivateFile(10001, "C:\\safe\\test.txt", "test.txt"),
    ).resolves.toBe("f1");
    expect(new URL(String(capturedInput)).pathname).toBe("/upload_private_file");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      user_id: "10001",
      name: "test.txt",
      upload_file: true,
    });
  });
});
