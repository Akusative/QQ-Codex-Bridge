import { describe, expect, it } from "vitest";
import {
  classifySensitiveContent,
  createSensitiveNoticeFacts,
} from "../src/security/sensitive-content-policy.js";

describe("classifySensitiveContent", () => {
  it("blocks explicit password assignments without returning the secret", () => {
    const result = classifySensitiveContent("密码是 synthetic-secret-value");
    expect(result).toEqual({ blocked: true, category: "password" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-value");
  });

  it("blocks private keys, cookies and verification codes", () => {
    expect(classifySensitiveContent("-----BEGIN PRIVATE KEY-----").blocked).toBe(true);
    expect(classifySensitiveContent("Cookie: sessionid=synthetic").blocked).toBe(true);
    expect(classifySensitiveContent("验证码为 123456").blocked).toBe(true);
  });

  it("does not block ordinary security questions", () => {
    expect(classifySensitiveContent("怎样修改密码？")).toEqual({ blocked: false });
    expect(classifySensitiveContent("解释一下 Cookie 的用途")).toEqual({ blocked: false });
  });

  it("creates persona-neutral facts without a fixed user-facing sentence", () => {
    expect(createSensitiveNoticeFacts("api_key_or_token")).toEqual({
      category: "api_key_or_token",
      contentWasBlocked: true,
      contentWasPersisted: false,
      mustNotQuoteOriginal: true,
      actionOwner: "user",
      mustNotRequestReplacement: true,
      recommendedAction: "revoke_and_replace_at_source",
    });
    expect(createSensitiveNoticeFacts("identity_document").recommendedAction).toBe(
      "do_not_send_again",
    );
    expect(createSensitiveNoticeFacts("password").recommendedAction).toBe(
      "change_password_at_source",
    );
    expect(createSensitiveNoticeFacts("cookie").recommendedAction).toBe(
      "invalidate_sessions_and_reauthenticate",
    );
  });
});
