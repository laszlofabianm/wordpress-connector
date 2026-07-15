import { readFile } from "node:fs/promises";

export async function readEnvFile(path = ".env"): Promise<Record<string, string>> {
  const entries = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line): [string, string] | null => {
      const separator = line.indexOf("=");
      if (separator < 1) return null;

      const key = line.slice(0, separator).trim();
      const value = line
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      return [key, value];
    })
    .filter((entry): entry is [string, string] => entry !== null);

  return Object.fromEntries(entries);
}

export function getRequiredEnv(
  env: Record<string, string>,
  key: string
): string {
  const value = env[key] ?? process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }

  return value;
}
