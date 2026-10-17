import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PROVIDER_ID } from "./constants.js";

export function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function providerApiKey(provider: { options?: Record<string, unknown> } | undefined): string {
  for (const field of ["apiKey", "api_key", "key", "token"] as const) {
    const key = normalizeKey(provider?.options?.[field]);
    if (key) return key;
  }
  return "";
}

function storedKey(content: string): string {
  const auth: unknown = JSON.parse(content);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return "";
  const entry: unknown = (auth as Record<string, unknown>)[PROVIDER_ID];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const value = entry as Record<string, unknown>;
  return value.type === "api" ? normalizeKey(value.key) : "";
}

/** Read-only V1 auth adapter, with no OpenCode globals or import-time I/O. */
export async function readStoredApiKey(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  try {
    if (env.OPENCODE_AUTH_CONTENT !== undefined) return storedKey(env.OPENCODE_AUTH_CONTENT);
    const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME : join(home, ".local", "share");
    return storedKey(await readText(join(dataHome, "opencode", "auth.json")));
  } catch {
    // Missing/malformed auth is unauthenticated. Never log credentials or file contents.
    return "";
  }
}

export async function resolveApiKey(
  provider: { options?: Record<string, unknown> } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readStored: () => Promise<string> = () => readStoredApiKey(env),
): Promise<string> {
  return providerApiKey(provider) || await readStored() || normalizeKey(env.RUROUT_API_KEY);
}
