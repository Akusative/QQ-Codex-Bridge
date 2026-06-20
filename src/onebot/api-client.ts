export interface OneBotApiClientOptions {
  baseUrl: string;
  accessToken: string;
  allowedUserId: number;
  fetchImpl?: typeof fetch;
}

interface OneBotActionResponse {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: {
    file_id?: string | null;
    user_id?: number;
    nickname?: string;
  };
}

export class OneBotApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OneBotApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getLoginInfo(): Promise<{ userId: number; nickname: string }> {
    const response = await this.fetchImpl(new URL("/get_login_info", this.options.baseUrl), {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`OneBot HTTP request failed with status ${response.status}`);
    }
    const result = (await response.json()) as OneBotActionResponse;
    if (
      result.retcode !== 0 ||
      result.status !== "ok" ||
      typeof result.data?.user_id !== "number"
    ) {
      throw new Error("OneBot login information is unavailable");
    }
    return {
      userId: result.data.user_id,
      nickname: result.data.nickname?.trim() || "QQ 机器人",
    };
  }

  async sendPrivateText(userId: number, text: string): Promise<void> {
    if (userId !== this.options.allowedUserId) {
      throw new Error("Refusing to send a private message outside the whitelist");
    }

    const response = await this.fetchImpl(
      new URL("/send_private_msg", this.options.baseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, message: text }),
      },
    );

    if (!response.ok) {
      throw new Error(`OneBot HTTP request failed with status ${response.status}`);
    }

    const result = (await response.json()) as OneBotActionResponse;
    if (result.retcode !== 0 || result.status !== "ok") {
      const detail = result.wording || result.message || "unknown OneBot error";
      throw new Error(`OneBot action failed: ${detail}`);
    }
  }

  async uploadPrivateFile(
    userId: number,
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    if (userId !== this.options.allowedUserId) {
      throw new Error("Refusing to send a private file outside the whitelist");
    }

    const response = await this.fetchImpl(
      new URL("/upload_private_file", this.options.baseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: String(userId),
          file: filePath,
          name: fileName,
          upload_file: true,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`OneBot HTTP request failed with status ${response.status}`);
    }

    const result = (await response.json()) as OneBotActionResponse;
    if (result.retcode !== 0 || result.status !== "ok") {
      const detail = result.wording || result.message || "unknown OneBot error";
      throw new Error(`OneBot action failed: ${detail}`);
    }
    return result.data?.file_id ?? null;
  }
}
