import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredAuthState {
  version: 1;
  password?: { salt: string; hash: string };
  sessions: Array<{ hash: string; expiresAt: number }>;
}

export class WebUiAuthStore {
  private state: StoredAuthState = { version: 1, sessions: [] };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoredAuthState;
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.cleanup();
  }

  isPasswordConfigured(): boolean {
    return Boolean(this.state.password);
  }

  async verifyPassword(password: string): Promise<boolean> {
    const stored = this.state.password;
    if (!stored) return false;
    const calculated = await deriveKey(password, Buffer.from(stored.salt, "base64url"));
    const expected = Buffer.from(stored.hash, "base64url");
    return calculated.length === expected.length && timingSafeEqual(calculated, expected);
  }

  async setPassword(password: string): Promise<void> {
    const salt = randomBytes(24);
    const hash = await deriveKey(password, salt);
    this.state.password = {
      salt: salt.toString("base64url"),
      hash: hash.toString("base64url"),
    };
    this.state.sessions = [];
    await this.save();
  }

  async addSession(hash: string, expiresAt: number): Promise<void> {
    await this.cleanup(false);
    this.state.sessions.push({ hash, expiresAt });
    await this.save();
  }

  hasSession(hash: string): boolean {
    return this.state.sessions.some(
      (session) => session.hash === hash && session.expiresAt > Date.now(),
    );
  }

  sessionCount(): number {
    const now = Date.now();
    return this.state.sessions.filter((session) => session.expiresAt > now).length;
  }

  async revokeSessions(): Promise<void> {
    this.state.sessions = [];
    await this.save();
  }

  private async cleanup(save = true): Promise<void> {
    const before = this.state.sessions.length;
    const now = Date.now();
    this.state.sessions = this.state.sessions.filter((session) => session.expiresAt > now);
    if (save && before !== this.state.sessions.length) await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
