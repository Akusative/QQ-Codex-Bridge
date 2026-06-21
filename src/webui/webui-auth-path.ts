import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const AUTH_FILE_NAME = "webui-auth.json";

export async function prepareWebUiAuthStorePath(installRoot: string): Promise<string> {
  const persistentPath = join(installRoot, "data", AUTH_FILE_NAME);
  if (await pathExists(persistentPath)) return persistentPath;

  const candidates = [
    join(installRoot, "dist", "data", AUTH_FILE_NAME),
    ...(await backupAuthCandidates(installRoot)),
  ];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    await mkdir(dirname(persistentPath), { recursive: true });
    try {
      await copyFile(candidate, persistentPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    break;
  }

  return persistentPath;
}

async function backupAuthCandidates(installRoot: string): Promise<string[]> {
  const updatesRoot = join(installRoot, "data", "updates");
  try {
    const entries = await readdir(updatesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .map((name) => join(updatesRoot, name, "dist", "data", AUTH_FILE_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
