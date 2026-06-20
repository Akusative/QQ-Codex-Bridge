import { stat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export async function ensureFileInsideRoot(
  filePath: string,
  allowedRoot: string,
): Promise<string> {
  const [target, root] = await Promise.all([
    realpath(filePath),
    realpath(allowedRoot),
  ]);
  const relation = relative(root, target);
  const outside =
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation);

  if (outside) {
    throw new Error("File is outside ALLOWED_WORKSPACE_ROOT");
  }
  if (!(await stat(target)).isFile()) {
    throw new Error("Path is not a regular file");
  }
  return target;
}
