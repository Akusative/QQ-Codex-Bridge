import { spawn } from "node:child_process";
import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml",
  ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".js", ".mjs",
  ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".cpp",
  ".h", ".hpp", ".ini", ".toml", ".log",
]);
const EXTRACTED_EXTENSIONS = new Set([".docx", ".pdf"]);

export const PERSONA_DOCUMENT_EXTENSIONS = [
  ...TEXT_EXTENSIONS,
  ...EXTRACTED_EXTENSIONS,
].sort();

export async function extractPersonaDocument(
  fileName: string,
  bytes: Buffer,
  pythonScriptPath: string,
): Promise<string> {
  const extension = extname(fileName).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return normalizeText(bytes.toString("utf8"));
  }
  if (!EXTRACTED_EXTENSIONS.has(extension)) {
    throw new Error("unsupported-type");
  }
  const text = await extractWithPython(extension, bytes, pythonScriptPath);
  return normalizeText(text);
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

async function extractWithPython(
  extension: string,
  bytes: Buffer,
  scriptPath: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("python", [scriptPath, extension], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`extract-failed:${Buffer.concat(stderr).toString("utf8").slice(0, 200)}`));
    });
    child.stdin.end(bytes);
  });
}
