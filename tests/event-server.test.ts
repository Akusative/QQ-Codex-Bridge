import { describe, expect, it } from "vitest";
import {
  containMessageError,
  extractPlainText,
  hasUserText,
  isSelfAuthored,
  RecentMessageCache,
  tokensEqual,
} from "../src/onebot/event-server.js";
import {
  isAllowedPrivateMessageEvent,
  isPrivateMessageEvent,
} from "../src/onebot/types.js";
import type { OneBotPrivateMessageEvent } from "../src/onebot/types.js";

function event(message: unknown, rawMessage = ""): OneBotPrivateMessageEvent {
  return {
    time: 0,
    self_id: 1,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 2,
    user_id: 3,
    message,
    raw_message: rawMessage,
  };
}

describe("OneBot event helpers", () => {
  it("extracts text from array messages", () => {
    expect(
      extractPlainText(
        event([
          { type: "text", data: { text: "/" } },
          { type: "text", data: { text: "ping" } },
        ]),
      ),
    ).toBe("/ping");
  });

  it("compares access tokens without accepting missing or partial values", () => {
    expect(tokensEqual("same-token", "same-token")).toBe(true);
    expect(tokensEqual("same", "same-token")).toBe(false);
    expect(tokensEqual(undefined, "same-token")).toBe(false);
  });

  it("contains asynchronous message errors instead of rejecting", async () => {
    const captured: unknown[] = [];
    await expect(
      containMessageError(Promise.reject(new Error("synthetic failure")), (error) => {
        captured.push(error);
      }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
  });

  it("ignores file-only events even when raw_message contains a placeholder", () => {
    const fileEvent = event(
      [{ type: "file", data: { file: "opaque-file-reference" } }],
      "[file]",
    );
    expect(hasUserText(fileEvent)).toBe(false);
  });

  it("identifies self-authored private events", () => {
    const selfEvent = {
      ...event("hello"),
      self_id: 42,
      sender: { user_id: 42 },
    };
    expect(isSelfAuthored(selfEvent)).toBe(true);
  });

  it("rejects group events and private events outside the whitelist", () => {
    const privateEvent = event("hello");
    const groupEvent = { ...privateEvent, message_type: "group" };
    expect(isPrivateMessageEvent(groupEvent)).toBe(false);
    expect(isAllowedPrivateMessageEvent(privateEvent, 999)).toBe(false);
    expect(isAllowedPrivateMessageEvent(privateEvent, 3)).toBe(true);
  });

  it("accepts a message id only once", () => {
    const cache = new RecentMessageCache(2);
    expect(cache.addIfNew("3:10")).toBe(true);
    expect(cache.addIfNew("3:10")).toBe(false);
  });
});
