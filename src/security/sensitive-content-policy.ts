export type SensitiveCategory =
  | "password"
  | "api_key_or_token"
  | "cookie"
  | "verification_code"
  | "private_key"
  | "identity_document";

export interface SensitiveContentResult {
  blocked: boolean;
  category?: SensitiveCategory;
}

export interface SensitiveNoticeFacts {
  category: SensitiveCategory;
  contentWasBlocked: true;
  contentWasPersisted: false;
  mustNotQuoteOriginal: true;
  actionOwner: "user";
  mustNotRequestReplacement: true;
  recommendedAction:
    | "change_password_at_source"
    | "revoke_and_replace_at_source"
    | "invalidate_sessions_and_reauthenticate"
    | "let_code_expire_and_do_not_reuse"
    | "revoke_and_replace_keypair"
    | "do_not_send_again";
}

const RULES: ReadonlyArray<{
  category: SensitiveCategory;
  pattern: RegExp;
}> = [
  {
    category: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    category: "api_key_or_token",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/,
  },
  {
    category: "api_key_or_token",
    pattern: /\b(?:api[_ -]?key|access[_ -]?token|bearer[_ -]?token)\s*(?:是|为|[:=])\s*\S{8,}/i,
  },
  {
    category: "cookie",
    pattern: /\b(?:cookie|set-cookie)\s*[:=]\s*\S+/i,
  },
  {
    category: "cookie",
    pattern: /\b(?:SESSDATA|bili_jct|sessionid)\s*=\s*\S+/i,
  },
  {
    category: "password",
    pattern: /(?:密码|password|passwd|pwd)\s*(?:是|为|[:=])\s*\S{4,}/i,
  },
  {
    category: "verification_code",
    pattern: /(?:验证码|校验码|动态码|OTP|one[- ]time code)\D{0,12}\d{4,8}\b/i,
  },
  {
    category: "identity_document",
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b/,
  },
];

export function classifySensitiveContent(text: string): SensitiveContentResult {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { blocked: true, category: rule.category };
    }
  }
  return { blocked: false };
}

export function createSensitiveNoticeFacts(
  category: SensitiveCategory,
): SensitiveNoticeFacts {
  const actions: Record<SensitiveCategory, SensitiveNoticeFacts["recommendedAction"]> = {
    password: "change_password_at_source",
    api_key_or_token: "revoke_and_replace_at_source",
    cookie: "invalidate_sessions_and_reauthenticate",
    verification_code: "let_code_expire_and_do_not_reuse",
    private_key: "revoke_and_replace_keypair",
    identity_document: "do_not_send_again",
  };

  return {
    category,
    contentWasBlocked: true,
    contentWasPersisted: false,
    mustNotQuoteOriginal: true,
    actionOwner: "user",
    mustNotRequestReplacement: true,
    recommendedAction: actions[category],
  };
}
